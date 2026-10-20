/** Local fixes for warnings traced on Cursor 3.25.9. No warning filtering. */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import * as acorn from 'acorn';
import { createBackup, restoreBackup } from './backup.js';
import { findAgentHostNetworkTargets } from './patch-agent-host.js';

export const RUNTIME_COMPAT_TAG = 'runtime-compat';
export const HTTP1_TIMEOUT_MARKER = '/*BYOK-HTTP1-TIMEOUT-DEFAULT*/';
const TIMEOUT_CALL = 'this.transportFactory.setHttp2SessionEstablishTimeoutMs(';
const PUNYCODE_REQUIRE = 'require("punycode")';
export const PUNYCODE_MARKER = '/*BYOK-PUNYCODE-USERLAND-2.3.1*/';

export function patchHttp1TimeoutSource(source) {
  if (source.includes(HTTP1_TIMEOUT_MARKER)) return source;
  const start = source.indexOf(TIMEOUT_CALL);
  if (start < 0 || source.indexOf(TIMEOUT_CALL, start + 1) >= 0)
    throw new Error('HTTP/2 timeout call must have exactly one match');
  let call = acorn.parseExpressionAt(source, start, {
    ecmaVersion: 'latest', allowAwaitOutsideFunction: true,
  });
  if (call.type === 'SequenceExpression') call = call.expressions[0];
  if (call.type !== 'CallExpression' || call.arguments.length !== 1)
    throw new Error('Unexpected HTTP/2 timeout call shape');
  const arg = call.arguments[0];
  const original = source.slice(arg.start, arg.end);
  if (arg.type !== 'AwaitExpression' || !original.includes('getDynamicConfigValue("http2_session_establish_timeout")')
      || !original.endsWith('(this.host)') || !original.includes('2e4'))
    throw new Error('HTTP/2 timeout semantics changed; refusing to patch');
  // The upstream fallback is 20s. HTTP/1.1 does not use HTTP/2 sessions,
  // so avoid requesting the absent Statsig config on that path only.
  return source.slice(0, arg.start)
    + `this.host.isHttp2Disabled()?2e4${HTTP1_TIMEOUT_MARKER}:${original}`
    + source.slice(arg.end);
}

export function patchPunycodeSource(source, library = readFileSync(assetPath('punycode.cjs'), 'utf8'), license = readFileSync(assetPath('punycode.LICENSE.txt'), 'utf8')) {
  if (source.includes(PUNYCODE_MARKER)) return source;
  if (source.split(PUNYCODE_REQUIRE).length !== 2)
    throw new Error('Retrieval punycode import must have exactly one match');
  // Inline the full MIT-licensed implementation in the existing webpack module.
  // Extra files in an official extension trigger its package verification warning.
  const replacement = `(function(){${PUNYCODE_MARKER}\n/*${license.replaceAll('*/', '* /')}*/\nvar module={exports:{}};\n${library}\nreturn module.exports;})()`;
  return source.replace(PUNYCODE_REQUIRE, () => replacement);
}

function targets(paths) {
  return [...new Set([paths.alwaysLocalMain, ...findAgentHostNetworkTargets(paths)])]
    .filter(path => path && existsSync(path));
}

function retrievalFile(paths) {
  return join(paths.appRoot, 'extensions', 'cursor-retrieval', 'dist', 'main.js');
}

function assetPath(name) {
  const roots = [
    typeof __dirname === 'string' ? __dirname : '',
    join(process.cwd(), 'assets', 'vendor'),
    join(process.cwd(), 'installer', 'assets', 'vendor'),
  ];
  const file = roots.filter(Boolean).map(root => join(root, name)).find(existsSync);
  if (!file) throw new Error(`Missing bundled compatibility asset: ${name}`);
  return file;
}

export function checkRuntimeCompat(paths, log) {
  const network = targets(paths);
  if (network.length < 2) throw new Error('Missing agent network compatibility targets');
  for (const path of network) {
    patchHttp1TimeoutSource(readFileSync(path, 'utf8'));
    log?.(`[runtime-compat] HTTP/1.1 timeout target verified: ${path}`);
  }
  patchPunycodeSource(readFileSync(retrievalFile(paths), 'utf8'));
  log?.('[runtime-compat] Retrieval punycode import verified');
  return true;
}

export function isRuntimeCompatPatched(paths) {
  const network = targets(paths);
  const retrieval = retrievalFile(paths);
  return network.length >= 2
    && network.every(path => readFileSync(path, 'utf8').includes(HTTP1_TIMEOUT_MARKER))
    && existsSync(retrieval) && readFileSync(retrieval, 'utf8').includes(PUNYCODE_MARKER);
}

export function patchRuntimeCompat(paths, log) {
  checkRuntimeCompat(paths, log);
  const retrieval = retrievalFile(paths);
  // Prepare every change and verify assets before any mutation.
  const edits = targets(paths).map(path => ({ path, source: patchHttp1TimeoutSource(readFileSync(path, 'utf8')) }));
  edits.push({ path: retrieval, source: patchPunycodeSource(readFileSync(retrieval, 'utf8')) });
  for (const { path, source } of edits) {
    if (source === readFileSync(path, 'utf8')) continue;
    createBackup(path, RUNTIME_COMPAT_TAG, log);
    writeFileSync(path, source);
    log?.(`[runtime-compat] Patched ${path}`);
  }
}

export function restoreRuntimeCompat(paths, log) {
  for (const path of [...targets(paths), retrievalFile(paths)])
    restoreBackup(path, RUNTIME_COMPAT_TAG, log);
  for (const name of ['ccursor-punycode.cjs', 'ccursor-punycode.LICENSE.txt'])
    rmSync(join(dirname(retrievalFile(paths)), name), { force: true });
}
