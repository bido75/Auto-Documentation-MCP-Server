#!/usr/bin/env node
/**
 * Guards acceptance skeletons: a file is only complete when it has no
 * it.todo/test.todo, skip, only, xit, or xdescribe contracts left.
 */
import fs from "node:fs";
import path from "node:path";

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\\\*\\\*/g, "__DOUBLE_STAR__").replace(/\\\*/g, "[^/]*").replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${pattern}$`);
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, acc);
    } else {
      acc.push(fullPath);
    }
  }
  return acc;
}

function resolveTargets(args) {
  const out = new Set();
  for (const arg of args) {
    if (arg.includes("*")) {
      const regex = globToRegex(arg);
      for (const file of walk(process.cwd(), [])) {
        const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
        if (regex.test(relative)) {
          out.add(relative);
        }
      }
    } else if (fs.existsSync(arg)) {
      out.add(arg);
    } else {
      process.stderr.write(`warning: no such file ${arg}\n`);
    }
  }
  return [...out];
}

const violations = [
  { name: "todo", re: /\b(it|test)\.todo\b/ },
  { name: "skip", re: /\b(it|test|describe)\.skip\b/ },
  { name: "only", re: /\b(it|test|describe)\.only\b/ },
  { name: "xit", re: /\bxit\b|\bxdescribe\b/ },
];

function stripComments(line, inBlock) {
  let code = line;
  if (inBlock.value) {
    const end = code.indexOf("*/");
    if (end === -1) {
      return "";
    }
    code = code.slice(end + 2);
    inBlock.value = false;
  }
  code = code.replace(/\/\*.*?\*\//g, "");
  const open = code.indexOf("/*");
  if (open !== -1) {
    inBlock.value = true;
    code = code.slice(0, open);
  }
  return code.replace(/\/\/.*$/, "");
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write("usage: check-acceptance-complete.js <file|glob>...\n");
    process.exit(2);
  }

  const files = resolveTargets(args);
  if (files.length === 0) {
    process.stderr.write("error: no files matched\n");
    process.exit(2);
  }

  let bad = 0;
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const hits = [];
    const inBlock = { value: false };
    lines.forEach((line, index) => {
      const code = stripComments(line, inBlock);
      if (!code.trim()) {
        return;
      }
      for (const violation of violations) {
        if (violation.re.test(code)) {
          hits.push({ line: index + 1, kind: violation.name, text: line.trim() });
        }
      }
    });

    if (hits.length > 0) {
      bad += 1;
      process.stdout.write(`INCOMPLETE  ${file}\n`);
      for (const hit of hits) {
        process.stdout.write(`   L${hit.line} [${hit.kind}] ${hit.text}\n`);
      }
    } else {
      process.stdout.write(`OK          ${file}\n`);
    }
  }

  if (bad > 0) {
    process.stdout.write(`\n${bad} file(s) still have unimplemented/skipped contracts. Item not done.\n`);
    process.exit(1);
  }

  process.stdout.write(`\nAll ${files.length} checked file(s) complete.\n`);
}

main();
