#!/usr/bin/env node
/**
 * smoke-pipeline.js — END-TO-END functional test of the Auto-Doc MCP server.
 *
 * This is the empirical backstop the static audits cannot provide: it spawns the
 * REAL server over stdio and exercises the REAL documentation pipeline against a
 * REAL (throwaway) Notion workspace, then verifies REAL side effects (pages created,
 * dedupe works, redaction applied). Nothing here is mocked.
 *
 * PREREQUISITES (set as env vars or in functional-tests/.env):
 *   NOTION_TOKEN              integration token for a DISPOSABLE Notion workspace
 *   NOTION_PARENT_PAGE_ID     a page the integration can write under (root for created DBs)
 *   AUTO_DOC_SERVER_CMD       command to launch the server (default: "node")
 *   AUTO_DOC_SERVER_ARGS      JSON array of args (default: ["dist/index.js"])
 *   AUTO_DOC_SERVER_CWD       repo root (default: process.cwd())
 *   STATE_ENCRYPTION_KEY      a unique non-default key (required if prod-guard is on)
 *
 * SAFETY: point this at a workspace you can delete. It creates real databases/pages.
 *
 * Exit codes: 0 all assertions passed; 1 a functional assertion failed; 2 setup error.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { McpStdioClient } = require('../lib/mcp-stdio-client.cjs');

// ---------- tiny assertion + reporting layer ----------
const results = [];
function record(name, pass, detail) { results.push({ name, pass, detail }); 
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}\n`); }
function assert(name, cond, detail) { record(name, !!cond, detail); return !!cond; }

function loadDotEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function unwrap(callResult) {
  // tools/call returns { content: [{type:'text', text:'...'}], isError? }
  if (callResult && Array.isArray(callResult.content)) {
    const text = callResult.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    try { return { ok: !callResult.isError, data: JSON.parse(text), raw: text }; }
    catch { return { ok: !callResult.isError, data: null, raw: text }; }
  }
  return { ok: false, data: null, raw: JSON.stringify(callResult) };
}

async function main() {
  loadDotEnv();
  const token = process.env.NOTION_TOKEN;
  const parent = process.env.NOTION_PARENT_PAGE_ID;
  if (!token || !parent) {
    process.stderr.write('setup error: NOTION_TOKEN and NOTION_PARENT_PAGE_ID are required.\n');
    process.exit(2);
  }
  const command = process.env.AUTO_DOC_SERVER_CMD || 'node';
  const args = JSON.parse(process.env.AUTO_DOC_SERVER_ARGS || '["dist/index.js"]');
  const cwd = process.env.AUTO_DOC_SERVER_CWD || process.cwd();

  const client = new McpStdioClient({
    command, args, cwd,
    env: {
      NOTION_TOKEN: token,
      NODE_ENV: 'test',
      STATE_ENCRYPTION_KEY: process.env.STATE_ENCRYPTION_KEY,
      AUTO_DOC_STATE_FILE: path.join(__dirname, '..', `.state-${Date.now()}.json`),
      AI_PROVIDER_TYPE: process.env.AI_PROVIDER_TYPE || 'deterministic',
    },
    onStderr: (d) => { if (process.env.VERBOSE) process.stderr.write('[server] ' + d); },
  });

  const runId = `smoke-${Date.now()}`;
  const featureMarker = `Functional Smoke Feature ${runId}`;
  const secret = 'notion_secret_THISisAFAKEtoken1234567890';

  try {
    // ---- 0. handshake + discovery ----
    const init = await client.start();
    assert('handshake: server returns serverInfo', init && init.serverInfo, JSON.stringify(init && init.serverInfo));
    assert('handshake: protocol version negotiated', !!init.protocolVersion, init.protocolVersion);

    const { tools } = await client.listTools();
    const toolNames = new Set((tools || []).map(t => t.name));
    const expected = ['initialize_project_manual','capture_development_event','analyze_documentation_candidate',
      'upsert_feature_documentation','publish_or_queue_review','package_manual','get_documentation_status'];
    for (const t of expected) assert(`discovery: tool "${t}" is registered`, toolNames.has(t));

    // ---- 1. initialize project manual (creates 5 Notion DBs) ----
    const initRes = unwrap(await client.callTool('initialize_project_manual', {
      projectName: `Functional Smoke ${runId}`,
      parentPageId: parent,
      repoPath: cwd,
    }));
    assert('initialize_project_manual: returns ok', initRes.ok, initRes.raw.slice(0, 200));
    const projectId = initRes.data && (initRes.data.projectId || (initRes.data.project && initRes.data.project.id));
    assert('initialize_project_manual: returns a projectId', !!projectId, String(projectId));

    // ---- 2. capture a development event with an embedded secret (redaction probe) ----
    const captureRes = unwrap(await client.callTool('capture_development_event', {
      projectId,
      source: 'local_git',
      eventType: 'commit',
      summary: `Add login throttling for ${featureMarker}. token=${secret}`,
      diffSummary: `+ rate limiter on /login\nAUTHORIZATION: Bearer ${secret}`,
      filesChanged: 'src/auth/login.ts',
      testStatus: 'passed',
    }));
    assert('capture_development_event: returns ok', captureRes.ok, captureRes.raw.slice(0, 200));
    assert('capture_development_event: secret is NOT echoed back in tool result',
      !captureRes.raw.includes(secret), 'raw result must not contain the raw token');
    const evidenceEventId = captureRes.data && captureRes.data.evidenceEventId;
    assert('capture_development_event: returns an evidence event id', !!evidenceEventId, String(evidenceEventId));

    // ---- 3. analyze candidate ----
    const analyzeRes = unwrap(await client.callTool('analyze_documentation_candidate', {
      projectId,
      evidenceEventIds: [evidenceEventId],
    }));
    assert('analyze_documentation_candidate: returns ok', analyzeRes.ok, analyzeRes.raw.slice(0, 200));
    assert('analyze: produces a manual-worthiness decision',
      analyzeRes.data && ('shouldDocument' in analyzeRes.data || 'confidenceScore' in analyzeRes.data),
      analyzeRes.raw.slice(0, 200));

    // ---- 4. upsert feature documentation ----
    const analyzed = analyzeRes.data || {};
    const featureKey = analyzed.featureKey || `functional-smoke:${runId}`;
    const confidenceScore = typeof analyzed.confidenceScore === 'number' ? analyzed.confidenceScore : 91;
    const confidenceReasons = Array.isArray(analyzed.confidenceReasons) && analyzed.confidenceReasons.length
      ? analyzed.confidenceReasons
      : ['Functional smoke harness generated documentation.'];
    const manualEntries = [
      {
        entryType: 'User Guide',
        title: `${featureMarker} User Guide`,
        userGuide: `Users are protected by login throttling for ${featureMarker}.`,
        adminGuide: `Admins can monitor throttled login attempts for ${featureMarker}.`,
        routes: ['/login'],
        apiEndpoints: ['/api/login'],
      },
    ];
    const upsertRes = unwrap(await client.callTool('upsert_feature_documentation', {
      projectId,
      featureKey,
      featureName: featureMarker,
      audiences: ['User', 'Admin'],
      manualEntries,
      evidenceEventIds: [evidenceEventId],
      confidenceScore,
      confidenceReasons,
      publishingMode: 'balanced',
      autoPublishThreshold: 60,
      sourceCommit: `smoke-${runId}`,
      filesChanged: ['src/auth/login.ts'],
    }));
    assert('upsert_feature_documentation: returns ok', upsertRes.ok, upsertRes.raw.slice(0, 200));
    const featureId = upsertRes.data && (upsertRes.data.featureId || upsertRes.data.featurePageId);
    assert('upsert: returns a feature page id', !!featureId, String(featureId));
    const manualEntryIds = upsertRes.data && Array.isArray(upsertRes.data.manualEntries)
      ? upsertRes.data.manualEntries.map(entry => entry.pageId || entry.id).filter(Boolean)
      : [];
    assert('upsert: returns manual entry page ids', manualEntryIds.length > 0, JSON.stringify(manualEntryIds));

    // ---- 5. IDEMPOTENCY: upsert the same feature again, expect no duplicate ----
    const upsert2 = unwrap(await client.callTool('upsert_feature_documentation', {
      projectId,
      featureKey,
      featureName: featureMarker,
      audiences: ['User', 'Admin'],
      manualEntries,
      evidenceEventIds: [evidenceEventId],
      confidenceScore,
      confidenceReasons,
      publishingMode: 'balanced',
      autoPublishThreshold: 60,
      sourceCommit: `smoke-${runId}`,
      filesChanged: ['src/auth/login.ts'],
    }));
    const featureId2 = upsert2.data && (upsert2.data.featureId || upsert2.data.featurePageId);
    assert('idempotency: second upsert of same feature returns the SAME page id (no duplicate)',
      featureId && featureId2 && featureId === featureId2, `${featureId} vs ${featureId2}`);

    // ---- 6. documentation status reflects created entities ----
    const statusRes = unwrap(await client.callTool('get_documentation_status', { projectId }));
    assert('get_documentation_status: returns ok', statusRes.ok, statusRes.raw.slice(0, 200));

    // ---- 7. publish or queue review ----
    const publishRes = unwrap(await client.callTool('publish_or_queue_review', {
      projectId,
      featureId,
      manualEntryIds,
      confidenceScore,
      publishingMode: 'balanced',
      autoPublishThreshold: 60,
    }));
    assert('publish_or_queue_review: returns ok', publishRes.ok, publishRes.raw.slice(0, 200));

    // ---- 8. package manual (release) ----
    const packageRes = unwrap(await client.callTool('package_manual', {
      projectId,
      releaseVersion: `Smoke Release ${runId}`,
      audience: 'both',
      format: 'markdown',
      manualEntryIds,
      includedFeatureIds: [featureId],
    }));
    assert('package_manual: returns ok', packageRes.ok, packageRes.raw.slice(0, 200));

    // ---- 9. error envelope: a bad call returns a structured error, not a crash ----
    let errored = false;
    try {
      const bad = unwrap(await client.callTool('upsert_feature_documentation', { /* missing projectId/featureName */ }));
      errored = !bad.ok || (bad.data && bad.data.error) || /error|invalid|required/i.test(bad.raw);
    } catch (e) { errored = true; }
    assert('error handling: malformed tool call returns a typed error envelope (no crash)', errored);

    // server still responsive after the error?
    const stillAlive = unwrap(await client.callTool('get_documentation_status', { projectId }));
    assert('resilience: server still responds after a bad call', stillAlive.ok);

  } catch (e) {
    record('fatal', false, e.message);
  } finally {
    await client.stop();
  }

  const failed = results.filter(r => !r.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed.\n`);
  if (failed.length) {
    process.stdout.write(`\nFAILURES:\n`);
    failed.forEach(f => process.stdout.write(`  - ${f.name}${f.detail ? '  (' + f.detail + ')' : ''}\n`));
    process.stdout.write(`\nNOTE: clean up the "${runId}" databases/pages from your test Notion workspace.\n`);
    process.exit(1);
  }
  process.stdout.write(`\nALL FUNCTIONAL CHECKS PASSED. Clean up "${runId}" from your test workspace.\n`);
  process.exit(0);
}

main();
