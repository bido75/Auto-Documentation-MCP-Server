#!/usr/bin/env node
/**
 * smoke-bridge.js — functional test of the HTTP/SSE bridge mode.
 *
 * Starts the REAL bridge as a subprocess and makes REAL HTTP requests to prove:
 *   - unauthenticated /sse and /runner/trigger are rejected (closed by default)
 *   - a valid client token is accepted
 *   - the env-token fallback does NOT leak the server token to anonymous callers
 *   - webhook ingestion accepts valid HMAC and rejects invalid/missing HMAC
 *
 * PREREQUISITES (env or functional-tests/.env):
 *   AUTO_DOC_BRIDGE_CMD     default "node"
 *   AUTO_DOC_BRIDGE_ARGS    JSON array, default ["dist/index.js"]   (with mode env below)
 *   AUTO_DOC_BRIDGE_ENV     JSON object of env to launch bridge mode (e.g. {"AUTO_DOC_RUNTIME_MODE":"bridge"})
 *   AUTO_DOC_BRIDGE_PORT    default 3000
 *   AUTO_DOC_BRIDGE_CWD     repo root (default cwd)
 *   BRIDGE_CLIENT_TOKEN     a valid client token the bridge will accept (if applicable)
 *   WEBHOOK_SECRET          HMAC secret configured for webhook routes (if applicable)
 *
 * Exit: 0 pass, 1 functional failure, 2 setup error.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const results = [];
function rec(name, pass, detail) { results.push({ name, pass }); 
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}\n`); }

function loadDotEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function waitForPort(port, timeoutMs = 15000) {
  const net = require('node:net');
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function tryOnce() {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error('bridge did not open port ' + port));
        else setTimeout(tryOnce, 300);
      });
    })();
  });
}

async function req(method, url, { headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

async function main() {
  loadDotEnv();
  const command = process.env.AUTO_DOC_BRIDGE_CMD || 'node';
  const args = JSON.parse(process.env.AUTO_DOC_BRIDGE_ARGS || '["dist/index.js"]');
  const cwd = process.env.AUTO_DOC_BRIDGE_CWD || process.cwd();
  const port = Number(process.env.AUTO_DOC_BRIDGE_PORT || 3000);
  const launchEnv = JSON.parse(process.env.AUTO_DOC_BRIDGE_ENV || '{"AUTO_DOC_RUNTIME_MODE":"bridge"}');
  const base = `http://127.0.0.1:${port}`;
  const SERVER_ENV_TOKEN = 'notion_ENV_token_should_never_leak_0000';

  const proc = spawn(command, args, {
    cwd,
    env: { ...process.env, ...launchEnv,
      NOTION_TOKEN: SERVER_ENV_TOKEN,
      // explicitly assert closed default: do NOT enable env-token fallback
      AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK: 'false',
      AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE: 'false',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => { if (process.env.VERBOSE) process.stdout.write('[bridge] ' + d); });
  proc.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write('[bridge] ' + d); });

  try {
    await waitForPort(port);
    rec('bridge: process opened the HTTP port', true, base);

    // 1. unauthenticated /sse rejected
    try {
      const r = await req('GET', `${base}/sse`, { headers: {} });
      rec('auth: unauthenticated /sse is rejected (401/403)', r.status === 401 || r.status === 403, 'status ' + r.status);
      rec('auth: server env token does not leak to anonymous /sse', !r.text.includes(SERVER_ENV_TOKEN));
    } catch (e) { rec('auth: unauthenticated /sse is rejected', false, e.message); }

    // 2. unauthenticated /runner/trigger rejected
    try {
      const r = await req('POST', `${base}/runner/trigger`, { headers: { 'content-type': 'application/json' }, body: '{}' });
      rec('auth: unauthenticated /runner/trigger is rejected', r.status === 401 || r.status === 403, 'status ' + r.status);
    } catch (e) { rec('auth: unauthenticated /runner/trigger is rejected', false, e.message); }

    // 3. valid client token accepted (if provided)
    if (process.env.BRIDGE_CLIENT_TOKEN) {
      try {
        const r = await req('GET', `${base}/sse`, { headers: { 'x-notion-token': process.env.BRIDGE_CLIENT_TOKEN } });
        rec('auth: valid client token is accepted on /sse', r.status >= 200 && r.status < 500 && r.status !== 401 && r.status !== 403, 'status ' + r.status);
      } catch (e) { rec('auth: valid client token is accepted on /sse', false, e.message); }
    } else {
      process.stdout.write('SKIP  auth: valid client token test (set BRIDGE_CLIENT_TOKEN to enable)\n');
    }

    // 4. webhook HMAC (if secret provided)
    if (process.env.WEBHOOK_SECRET) {
      const payload = JSON.stringify({ event: 'push', ref: 'refs/heads/main', repo: 'smoke' });
      const sig = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(payload).digest('hex');
      const candidates = ['/webhook', '/webhooks', '/webhook/github', '/mcp/webhook'];
      let hookPath = null;
      for (const c of candidates) {
        const probe = await req('POST', `${base}${c}`, { headers: { 'content-type': 'application/json' }, body: '{}' });
        if (probe.status !== 404) { hookPath = c; break; }
      }
      if (hookPath) {
        const good = await req('POST', `${base}${hookPath}`, {
          headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${sig}` }, body: payload });
        rec('webhook: valid HMAC signature accepted', good.status >= 200 && good.status < 300, hookPath + ' status ' + good.status);
        const bad = await req('POST', `${base}${hookPath}`, {
          headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' }, body: payload });
        rec('webhook: invalid HMAC signature rejected', bad.status === 401 || bad.status === 403, 'status ' + bad.status);
        const none = await req('POST', `${base}${hookPath}`, {
          headers: { 'content-type': 'application/json' }, body: payload });
        rec('webhook: missing HMAC signature rejected', none.status === 401 || none.status === 403, 'status ' + none.status);
      } else {
        process.stdout.write('SKIP  webhook tests (no webhook route found at common paths)\n');
      }
    } else {
      process.stdout.write('SKIP  webhook tests (set WEBHOOK_SECRET to enable)\n');
    }

  } catch (e) {
    rec('fatal', false, e.message);
  } finally {
    try { proc.kill('SIGTERM'); } catch {}
  }

  const failed = results.filter(r => !r.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed.\n`);
  process.exit(failed.length ? 1 : 0);
}

main();
