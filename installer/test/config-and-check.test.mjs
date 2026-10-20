import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const installerRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = mkdtempSync(join(tmpdir(), 'ccursor-config-check-'));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

// Exercise the shipped CommonJS entrypoints without installing or modifying Cursor.
for (const [entry, name] of [['src/cli.js', 'cli.cjs'], ['src/release-defaults.js', 'release-defaults.cjs']]) {
  buildSync({
    entryPoints: [join(installerRoot, entry)],
    outfile: join(fixtureRoot, name),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent',
  });
}
copyFileSync(join(installerRoot, 'assets/models-catalog.json'), join(fixtureRoot, 'models-catalog.json'));
const { releaseDefaults } = createRequire(import.meta.url)(join(fixtureRoot, 'release-defaults.cjs'));

for (const byokMode of [0, 1]) {
  test(`releasing defaults preserves NAS routes, Max provider and private mode with BYOK ${byokMode}`, () => {
    const configDir = join(fixtureRoot, `config-${byokMode}`);
    mkdirSync(configDir);
    const routes = Buffer.from(JSON.stringify({
      $schemaVersion: 1,
      byokMode,
      server: { host: '127.0.0.7', port: 41234 },
      collector: { host: '127.0.0.8', port: 41235 },
      redirect: ['/agent.v1.AgentService/RunSSE', '/custom-nas-path'],
      customPreference: 'retain this field',
    }, null, '\t') + '\r\n');
    const providers = Buffer.from('{ "providers": [{ "id": "nas", "baseUrl": "https://nas.example/cursor/v1", "apiKey": "fixture-only", "models": [{ "id": "nas-model", "thinkingLevel": "max" }] }] }\r\n');
    writeFileSync(join(configDir, 'routes.json'), routes, { mode: 0o600 });
    writeFileSync(join(configDir, 'providers.json'), providers, { mode: 0o600 });
    const logs = [];

    releaseDefaults(message => logs.push(message), { configDir });
    releaseDefaults(message => logs.push(message), { configDir });

    assert.deepEqual(readFileSync(join(configDir, 'routes.json')), routes);
    assert.deepEqual(readFileSync(join(configDir, 'providers.json')), providers);
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(configDir, 'routes.json')).mode & 0o777, 0o600);
      assert.equal(statSync(join(configDir, 'providers.json')).mode & 0o777, 0o600);
    }
    assert.ok(logs.every(message => !message.includes('[detect]')), 'existing routes must not trigger login-state detection');
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(configDir, 'web-tools.json'), 'utf8')));
    assert.deepEqual(readFileSync(join(configDir, 'models-catalog.json')), readFileSync(join(fixtureRoot, 'models-catalog.json')));
  });
}

function runCheck(appRoot) {
  return spawnSync(process.execPath, [join(fixtureRoot, 'cli.cjs'), 'check'], {
    encoding: 'utf8',
    env: { ...process.env, CCURSOR_CURSOR_ROOT: appRoot },
    timeout: 10000,
  });
}

test('check exits nonzero when Cursor is not found', () => {
  const result = runCheck(join(fixtureRoot, 'missing-cursor'));
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Cursor installation not found/);
  assert.match(result.stderr, /Cursor installation not found/);
});

test('check exits nonzero when patch targets do not match and leaves the fixture unchanged', () => {
  const appRoot = join(fixtureRoot, 'incompatible-cursor');
  const originals = new Map([
    ['package.json', '{"version":"3.25.9"}'],
    ['product.json', '{}'],
    ['out/vs/workbench/workbench.desktop.main.js', 'console.log("incompatible bundle");'],
  ]);
  for (const [relativePath, source] of originals) {
    const file = join(appRoot, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }

  const result = runCheck(appRoot);

  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Some targets not matchable/);
  assert.match(result.stderr, /Some patch targets are not matchable/);
  for (const [relativePath, source] of originals)
    assert.equal(readFileSync(join(appRoot, relativePath), 'utf8'), source);
});
