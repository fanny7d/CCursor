/**
 * ccursor check — dry-run verify all AST patch targets are matchable
 */
import { existsSync, readFileSync } from 'fs';
import { findCursorPathsDetailed, formatDiagnostic } from './detect.js';
import { checkAlwaysLocalPatch } from './patch-always-local.js';
import { checkAgentHostPatch } from './patch-agent-host.js';
import { checkProxy39Patch, needsProxy39Patch } from './patch-proxy-39.js';
import { checkAgentHostGatePatch } from './patch-agent-host-gate.js';
import { findTarget, isInjectPatched, prepareRendererSource } from './patch-inject.js';
import { checkRuntimeCompat } from './patch-runtime-compat.js';

const ok = s => `\x1b[32m✓ ${s}\x1b[0m`;
const fail = s => `\x1b[31m✗ ${s}\x1b[0m`;
const info = s => `\x1b[34m[>]\x1b[0m ${s}`;

export async function check(overridePaths) {
  const { paths, diagnostic } = overridePaths?.appRoot ? { paths: overridePaths, diagnostic: {} } : findCursorPathsDetailed();
  if (!paths) {
    console.log(fail('Cursor installation not found'));
    console.log();
    console.log(formatDiagnostic(diagnostic));
    throw new Error('Cursor installation not found');
  }

  console.log(info(`Cursor: ${paths.appRoot}`));
  console.log();

  let allOk = true;
  try { checkRuntimeCompat(paths, s => console.log(info(s))); }
  catch (error) { console.log(fail(error.message)); allOk = false; }

  // 1. Renderer hook target (same AST matcher as the inject patch) — desktop + glass
  for (const [file, label] of [[paths.workbenchJs, 'desktop'], [paths.glassJs, 'glass']]) {
    if (!existsSync(file)) {
      if (label === 'glass') console.log(info('Glass workbench not found (pre-3.8, OK)'));
      continue;
    }
    const wb = prepareRendererSource(readFileSync(file, 'utf-8'));
    if (isInjectPatched(wb)) {
      console.log(ok(`Renderer hook (${label}): payload + active transport call site`));
      continue;
    }
    if (wb.includes('__byokWrapTransport') || wb.includes('CURSOR-BYOK-HOOK-START')) {
      console.log(fail(`Renderer hook (${label}) is partial (payload/call-site mismatch)`));
      allOk = false;
      continue;
    }
    try {
      const target = findTarget(wb, s => console.log(info(s)));
      console.log(ok(`Renderer hook target (${label}): function ${target.name}`));
    } catch (error) {
      console.log(fail(`Renderer hook target (${label}) not matchable: ${error.message}`));
      allOk = false;
    }
  }

  // 2. Signature bypass pattern
  if (existsSync(paths.extensionHostJs)) {
    const eh = readFileSync(paths.extensionHostJs, 'utf-8');
    const hasSigPattern = /if\(!\w\.valid\)/.test(eh);
    const alreadyBypassed = eh.includes('if(!1)') && !hasSigPattern;
    if (hasSigPattern || alreadyBypassed) {
      console.log(ok(`Sig bypass: ${alreadyBypassed ? 'already applied' : 'pattern found'}`));
    } else {
      console.log(fail('Sig bypass pattern not found'));
      allOk = false;
    }
  } else {
    console.log(fail('extensionHostProcess.js not found (required for signature patch)'));
    allOk = false;
  }

  // 3. Legacy Agent process: executable HTTP/1.1 router + wait
  const alwaysLocalOk = checkAlwaysLocalPatch(paths, s => console.log(info(s)));
  if (!alwaysLocalOk) allOk = false;

  // 4. Independent Agent Host process (3.13+): semantic network target + no WebSocket
  console.log(info('[check] Verifying cursor-agent-host transport coverage...'));
  const agentHostOk = checkAgentHostPatch(paths, s => console.log(info(s)));
  if (!agentHostOk) allOk = false;

  // 5. Cursor 3.9+ singleton BYOK router/proxy target
  if (needsProxy39Patch(paths)) {
    console.log(info('[check] Verifying Cursor 3.9 singleton BYOK router/proxy patch target...'));
    const proxyOk = checkProxy39Patch(paths, s => console.log(info(s)));
    if (!proxyOk) allOk = false;
  } else {
    console.log(info('Cursor 3.9 singleton BYOK router/proxy patch not required'));
  }

  // 5b. Cursor 3.23+ agent-host gate off target
  console.log(info('[check] Verifying cursor_agent_host gate-off target...'));
  const agentGateOk = checkAgentHostGatePatch(paths, s => console.log(info(s)));
  if (!agentGateOk) allOk = false;

  // 6. cursor-always-local main.js
  if (existsSync(paths.alwaysLocalMain)) {
    console.log(ok('cursor-always-local main.js found'));
  } else {
    console.log(fail('cursor-always-local main.js not found'));
    allOk = false;
  }

  console.log();
  if (allOk) {
    console.log(ok('All patch targets matchable'));
  } else {
    console.log(fail('Some targets not matchable — install may fail'));
    throw new Error('Some patch targets are not matchable');
  }
}
