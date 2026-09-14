#!/usr/bin/env node
/**
 * mcp-stdio-client.js — minimal, dependency-free MCP client over stdio (JSON-RPC 2.0).
 *
 * Spawns the server as a subprocess, performs the initialize handshake, then lets you
 * call tools/list and tools/call. Newline-delimited JSON-RPC on stdin/stdout.
 *
 * This is REAL protocol traffic — the same path a host like Claude Desktop uses.
 * Use it to prove the server actually responds to tool calls end-to-end.
 *
 * Usage (as a library):
 *   const { McpStdioClient } = require('./mcp-stdio-client');
 *   const c = new McpStdioClient({ command: 'node', args: ['dist/index.js'], env: {...} });
 *   await c.start();                       // spawn + initialize handshake
 *   const tools = await c.listTools();     // tools/list
 *   const res = await c.callTool('initialize_project_manual', { ... });  // tools/call
 *   await c.stop();
 */
'use strict';
const { spawn } = require('node:child_process');

const PROTOCOL_VERSION = '2025-06-18'; // negotiated; server may downgrade in its response

class McpStdioClient {
  constructor({ command, args = [], env = {}, cwd, requestTimeoutMs = 30000, onStderr } = {}) {
    this.command = command;
    this.args = args;
    this.env = { ...process.env, ...env };
    this.cwd = cwd;
    this.requestTimeoutMs = requestTimeoutMs;
    this.onStderr = onStderr || (() => {});
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.serverInfo = null;
    this.stderrLog = [];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn(this.command, this.args, { cwd: this.cwd, env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'] });

      this.proc.on('error', reject);
      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
      this.proc.stderr.setEncoding('utf8');
      this.proc.stderr.on('data', (d) => { this.stderrLog.push(d); this.onStderr(d); });
      this.proc.on('exit', (code, sig) => {
        for (const [, p] of this.pending) p.reject(new Error(`server exited (code=${code}, sig=${sig})`));
        this.pending.clear();
      });

      // initialize handshake
      this._request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'functional-test-client', version: '1.0.0' },
      }).then((res) => {
        this.serverInfo = res;
        // confirm readiness (one-way notification)
        this._notify('notifications/initialized', {});
        resolve(res);
      }).catch(reject);
    });
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // ignore non-JSON log noise on stdout
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'rpc error'), { rpc: msg.error }));
        else p.resolve(msg.result);
      }
      // notifications from server are ignored for this harness
    }
  }

  _request(method, params) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${this.requestTimeoutMs}ms: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(payload);
    });
  }

  _notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  listTools() { return this._request('tools/list', {}); }

  async callTool(name, args = {}) {
    const res = await this._request('tools/call', { name, arguments: args });
    return res; // { content: [...], isError?: boolean, structuredContent?: ... }
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.proc || this.proc.exitCode !== null) return resolve();
      this.proc.on('exit', () => resolve());
      try { this.proc.stdin.end(); } catch {}
      setTimeout(() => { try { this.proc.kill('SIGTERM'); } catch {} resolve(); }, 1500);
    });
  }
}

module.exports = { McpStdioClient, PROTOCOL_VERSION };
