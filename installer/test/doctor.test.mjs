import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectDiagnostics } from '../src/doctor.js';

test('doctor exports only allowlisted metadata and counts, even for secret-bearing local responses', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ccursor-doctor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appRoot = join(root, 'private-user-path'), configDir = join(root, 'private-config');
  const paths = { appRoot, productJson: join(appRoot, 'product.json'), cursorVersion: '3.25.9', cursor2plusDir: join(appRoot, 'extensions/cursor2plus'),
    workbenchJs: join(appRoot, 'out/workbench.js'), glassJs: join(appRoot, 'out/absent.js') };
  for (const [file, body] of [
    [paths.productJson, '{}'], [join(paths.cursor2plusDir, 'package.json'), '{"version":"0.1.0"}'],
    [join(paths.cursor2plusDir, 'dist/extension.js'), 'public code'], [paths.workbenchJs, 'public code'],
    [join(configDir, 'routes.json'), '{"server":{"host":"127.0.0.1","port":41000},"private":"synthetic-route-secret"}'],
    [join(configDir, 'providers.json'), '{"providers":[{"apiKey":"synthetic-api-key","baseUrl":"https://private.example"}]}'],
    [join(configDir, 'local-access.json'), JSON.stringify({ token: 'a'.repeat(64) })],
  ]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body, { mode: 0o600 }); }
  const calls = [];
  const report = await collectDiagnostics(paths, { configDir, request: async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(url.endsWith('/health')
      ? { ok: true, version: '0.1.0', build: 'private-secret-build', localAccessProtocol: 1, apiKey: 'synthetic-api-key' }
      : { outcomes: { completed: 2, cancelled: -1, unknown: 'synthetic-error-secret' }, prompt: 'synthetic-prompt-secret', path: root }));
  } });
  assert.equal(report.runtime.health, 'ok');
  assert.equal(report.runtime.upstreamOutcomes.completed, 2);
  assert.equal(report.runtime.upstreamOutcomes.cancelled, 0);
  assert.equal(report.runtime.build, 'unknown');
  assert.equal(calls[1].init.headers['x-ccursor-token'], 'a'.repeat(64));
  assert.equal(calls[0].init.redirect, 'error');
  const exported = JSON.stringify(report);
  for (const secret of [root, 'private-user-path', 'synthetic-api-key', 'private.example', 'synthetic-route-secret', 'synthetic-prompt-secret', 'synthetic-error-secret', 'a'.repeat(64)]) assert.equal(exported.includes(secret), false);
});

test('doctor never follows config-provided remote addresses and does not treat health as upstream verification', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ccursor-doctor-remote-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'routes.json'), '{"server":{"host":"external.example","port":443}}');
  const paths = { appRoot: root, cursorVersion: '3.25.9', cursor2plusDir: join(root, 'extension') };
  let calls = 0;
  const report = await collectDiagnostics(paths, { configDir: root, request: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(report.runtime.health, 'probe-skipped');
  assert.equal(report.runtime.upstreamOutcomes, null);
});
