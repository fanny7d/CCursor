import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { findCursorPathsDetailed } from './detect.js';
import { CCURSOR_DIR } from './routes.js';
import { digest, INSTALLATION_MANIFEST, validateInstallation } from './installation-state.js';
import { isInjectPatched } from './patch-inject.js';
import { isRuntimeCompatPatched } from './patch-runtime-compat.js';
import { inspectAlwaysLocalPatch } from './patch-always-local.js';
import { JOURNAL_FILE } from './transaction.js';
import { compatibilityState } from './compatibility-state.js';
import { macOSBundle, inspectMacOSSignature } from './macos-signing.js';
import { macOSJournal } from './macos-transaction.js';

const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(value) ? value : 'unknown';
const revision = value => typeof value === 'string' && /^[a-f0-9]{40}(?:-dirty)?$/i.test(value) ? value : 'unknown';
const safe = fn => { try { return fn(); } catch { return null; } };
const json = file => safe(() => JSON.parse(readFileSync(file, 'utf8')));
const OUTCOMES = ['completed', 'cancelled', 'authentication', 'quota', 'rate_limit', 'request', 'timeout', 'network', 'unavailable', 'unknown', 'truncated', 'filtered'];

export async function collectDiagnostics(paths, { configDir = CCURSOR_DIR, request = fetch } = {}) {
  // This is an allowlist report, not a redacted copy of config/logs/HTTP bodies.
  const report = { schemaVersion: 1, platform: process.platform, architecture: process.arch, cursorFound: !!paths,
    cursorVersion: version(paths?.cursorVersion), installerVersion: version(process.env.CURSOR2PLUS_VERSION),
    installerBuild: revision(process.env.CCURSOR_BUILD_SHA) };
  if (!paths) return report;
  report.compatibility = compatibilityState(paths, { configDir });
  const bundle = macOSBundle(paths);
  report.macOSSignature = bundle ? inspectMacOSSignature(bundle) : { applicable: false };
  const manifest = json(join(paths.appRoot, INSTALLATION_MANIFEST));
  const extension = json(join(paths.cursor2plusDir, 'package.json'));
  report.installation = { recorded: !!manifest, verified: safe(() => { validateInstallation(paths); return !!manifest; }) === true,
    recoveryPending: existsSync(join(paths.appRoot, JOURNAL_FILE)) || !!(bundle && existsSync(macOSJournal(bundle))),
    extensionVersion: version(extension?.version), recordedBuild: revision(manifest?.build),
    extensionSha256: safe(() => digest(readFileSync(join(paths.cursor2plusDir, 'dist/extension.js')))) };
  report.patches = {
    rendererDesktop: safe(() => isInjectPatched(readFileSync(paths.workbenchJs, 'utf8'))) === true,
    rendererGlass: safe(() => isInjectPatched(readFileSync(paths.glassJs, 'utf8'))) === true,
    localRouter: safe(() => paths.alwaysLocalMain ? inspectAlwaysLocalPatch(paths).fullyPatched : false) === true,
    runtimeCompatibility: safe(() => isRuntimeCompatPatched(paths)) === true,
  };
  report.config = Object.fromEntries(['providers.json', 'routes.json', 'local-access.json'].map(name => {
    const path = join(configDir, name);
    return [name, { present: existsSync(path), private: process.platform === 'win32' ? null : safe(() => (statSync(path).mode & 0o077) === 0) }];
  }));
  const routes = json(join(configDir, 'routes.json'));
  const host = routes?.server?.host || '127.0.0.1';
  const port = routes?.server?.port || 39831;
  report.runtime = { health: 'unreachable', version: 'unknown', build: 'unknown', localAccessProtocol: 0, upstreamOutcomes: null };
  // A diagnostic command must never probe an arbitrary config-provided host.
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    report.runtime.health = 'probe-skipped';
    return report;
  }
  const base = `http://${host === '::1' ? '[::1]' : host}:${port}`;
  try {
    const response = await request(`${base}/health`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
    const health = await response.json();
    report.runtime.health = response.ok && health.ok === true ? 'ok' : 'unexpected';
    report.runtime.version = version(health.version);
    report.runtime.build = revision(health.build);
    report.runtime.localAccessProtocol = health.localAccessProtocol === 1 ? 1 : 0;
    const auth = json(join(configDir, 'local-access.json'));
    if (typeof auth?.token === 'string' && /^[a-f0-9]{64}$/.test(auth.token)) {
      const result = await request(`${base}/byok/diagnostics`, { headers: { 'x-ccursor-token': auth.token }, signal: AbortSignal.timeout(2500), redirect: 'error' });
      if (result.ok) {
        const body = await result.json();
        report.runtime.upstreamOutcomes = Object.fromEntries(OUTCOMES.map(name => [name,
          Number.isSafeInteger(body.outcomes?.[name]) && body.outcomes[name] >= 0 ? body.outcomes[name] : 0]));
      }
    }
  } catch { /* Keep bounded, coarse failure state; never export raw errors or URLs. */ }
  return report;
}

export async function doctor({ output } = {}) {
  const { paths } = findCursorPathsDetailed();
  const report = await collectDiagnostics(paths);
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (output) writeFileSync(output, serialized, { mode: 0o600, flag: 'wx' });
  console.log(serialized.trimEnd());
  return report;
}
