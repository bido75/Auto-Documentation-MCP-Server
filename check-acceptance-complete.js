#!/usr/bin/env node
/**
 * check-acceptance-complete.js
 *
 * Guards the acceptance-test skeletons: an item is only "done" when its file has
 * ZERO remaining `.todo` and ZERO `.skip`/`.only`/`xit`. Run this in CI (or a
 * pre-PR hook) for whichever items the agent claims complete.
 *
 * Usage:
 *   node check-acceptance-complete.js <testFileGlobOrPath> [...more]
 *   node check-acceptance-complete.js tests/integration/runner-entrypoint.integration.test.ts
 *   node check-acceptance-complete.js "tests/**\/*.test.ts"      # check everything
 *
 * Exit codes:
 *   0  all checked files are complete (no todo/skip/only)
 *   1  at least one file still has an unimplemented or skipped contract
 *   2  bad usage / no files matched
 *
 * Zero dependencies. Pure Node + fs. Glob support is minimal (supports ** and *).
 */
import fs from "node:fs";
import path from "node:path";

function globToRegex(glob) {
  // very small glob: ** -> any path, * -> any non-slash run
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = esc.replace(/\\\*\\\*/g, '§§').replace(/\\\*/g, '[^/]*').replace(/§§/g, '.*');
  return new RegExp('^' + re + '$');
}

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function resolveTargets(args) {
  const out = new Set();
  for (const a of args) {
    if (a.includes('*')) {
      const re = globToRegex(a);
      walk(process.cwd(), []).forEach(f => {
        const rel = path.relative(process.cwd(), f).split(path.sep).join('/');
        if (re.test(rel)) out.add(rel);
      });
    } else if (fs.existsSync(a)) {
      out.add(a);
    } else {
      process.stderr.write(`warning: no such file ${a}\n`);
    }
  }
  return [...out];
}

// Patterns that indicate an unfulfilled or evaded contract.
const VIOLATIONS = [
  { name: 'todo',  re: /\b(it|test)\.todo\b/ },
  { name: 'skip',  re: /\b(it|test|describe)\.skip\b/ },
  { name: 'only',  re: /\b(it|test|describe)\.only\b/ },
  { name: 'xit',   re: /\bxit\b|\bxdescribe\b/ },
];

function main() {
  const args = process.argv.slice(2);
  if (!args.length) { process.stderr.write('usage: check-acceptance-complete.js <file|glob>...\n'); process.exit(2); }
  const files = resolveTargets(args);
  if (!files.length) { process.stderr.write('error: no files matched\n'); process.exit(2); }

  let bad = 0;
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const hits = [];
    let inBlock = false;
    lines.forEach((ln, i) => {
      let code = ln;
      // strip/track block comments so header docs ("DO NOT SKIP") don't trip it
      if (inBlock) {
        const end = code.indexOf('*/');
        if (end === -1) return;            // whole line is inside a block comment
        code = code.slice(end + 2);
        inBlock = false;
      }
      code = code.replace(/\/\*.*?\*\//g, '');       // inline block comments
      const open = code.indexOf('/*');
      if (open !== -1) { inBlock = true; code = code.slice(0, open); }
      code = code.replace(/\/\/.*$/, '');            // line comments
      if (!code.trim()) return;
      for (const v of VIOLATIONS) if (v.re.test(code)) hits.push({ line: i + 1, kind: v.name, text: ln.trim() });
    });
    if (hits.length) {
      bad++;
      process.stdout.write(`INCOMPLETE  ${f}\n`);
      hits.forEach(h => process.stdout.write(`   L${h.line} [${h.kind}] ${h.text}\n`));
    } else {
      process.stdout.write(`OK          ${f}\n`);
    }
  }
  if (bad) {
    process.stdout.write(`\n${bad} file(s) still have unimplemented/skipped contracts. Item not done.\n`);
    process.exit(1);
  }
  process.stdout.write(`\nAll ${files.length} checked file(s) complete.\n`);
  process.exit(0);
}

main();
