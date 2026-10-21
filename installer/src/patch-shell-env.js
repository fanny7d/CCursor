/** Preserve shell results queued while the macOS main process was blocked. */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { createBackup, restoreBackup } from './backup.js';
import { updateChecksums } from './checksum.js';

export const SHELL_ENV_TAG = 'shell-env';
export const SHELL_ENV_MARKER = '/*BYOK-SHELL-ENV-DEADLINE-1*/';
const SETTING = 'application.shellEnvironmentResolutionTimeout';

// Keep the configured deadline for a slow shell. Only an already-overdue
// macOS timer gets one bounded chance to drain queued child-process events.
// Both the initial timer and its replacement are cancelled on settlement.
const HELPER = `function __ccursorShellEnvDeadline(expire, delay, log) {
  ${SHELL_ENV_MARKER}
  const __ccursorStarted = performance.now();
  let __ccursorHandle = setTimeout(() => {
    const late = performance.now() - __ccursorStarted - delay;
    if (process.platform === 'darwin' && late >= 1000) {
      log.trace('getUnixShellEnvironment#drainAfterMainLoopStall', { lateMs: Math.round(late), graceMs: 1000 });
      __ccursorHandle = setTimeout(expire, 1000);
    } else {
      expire();
    }
  }, delay);
  return { dispose() { clearTimeout(__ccursorHandle); } };
}`;

function inspect(source) {
  const anchor = source.indexOf(SETTING);
  if (anchor < 0 || source.indexOf(SETTING, anchor + 1) >= 0)
    throw new Error('Shell environment timeout setting must have exactly one match');
  const start = source.lastIndexOf('async function ', anchor);
  if (start < 0) throw new Error('Shell environment resolver function not found');
  const fn = acorn.parseExpressionAt(source, start, { ecmaVersion: 'latest' });
  if (fn.type !== 'FunctionExpression' || !fn.async || fn.end <= anchor
      || fn.params.length !== 4 || fn.params.some(p => p.type !== 'Identifier'))
    throw new Error('Shell environment resolver shape changed');
  const patched = source.includes(SHELL_ENV_MARKER);
  if (patched && (source.split(SHELL_ENV_MARKER).length !== 2 || !source.includes(HELPER)))
    throw new Error('Partial or changed shell environment deadline patch');
  const timers = [], clears = [];
  walk.simple(fn, {
    VariableDeclarator(node) {
      if (node.id.type !== 'Identifier' || node.init?.type !== 'CallExpression') return;
      const call = node.init;
      const original = call.callee.type === 'Identifier' && call.callee.name === 'setTimeout';
      const wrapped = call.callee.type === 'FunctionExpression' && call.callee.id?.name === '__ccursorShellEnvDeadline';
      if ((!patched && original) || (patched && wrapped)) timers.push(node);
    },
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'clearTimeout') clears.push(node);
    },
  });
  if (timers.length !== 1) throw new Error('Shell environment deadline must have exactly one timer');
  const timer = timers[0], call = timer.init;
  const [callback, delay] = call.arguments;
  const body = callback?.body;
  const sequence = body?.type === 'BlockStatement' && body.body.length === 1
    && body.body[0].type === 'ExpressionStatement' && body.body[0].expression;
  const expressions = sequence?.type === 'SequenceExpression' ? sequence.expressions : [];
  const [cancel, reject] = expressions;
  const flag = cancel?.arguments?.[0];
  const cancels = flag?.type === 'Literal' && flag.value === true
    || flag?.type === 'UnaryExpression' && flag.operator === '!' && flag.argument.type === 'Literal' && flag.argument.value === 0;
  if (callback?.type !== 'ArrowFunctionExpression' || callback.params.length !== 0
      || delay?.type !== 'Identifier' || call.arguments.length !== (patched ? 3 : 2)
      || expressions.length !== 2 || cancel?.type !== 'CallExpression'
      || cancel.callee.type !== 'MemberExpression' || cancel.callee.computed
      || cancel.callee.property.name !== 'dispose' || cancel.callee.object.type !== 'Identifier'
      || cancel.arguments.length !== 1 || !cancels
      || reject?.type !== 'CallExpression' || reject.callee.type !== 'Identifier'
      || reject.arguments.length !== 1 || reject.arguments[0].type !== 'NewExpression'
      || reject.arguments[0].callee.name !== 'Error')
    throw new Error('Shell environment cancellation semantics changed; refusing to patch');
  if (patched) {
    const cleanup = [];
    walk.simple(fn, { CallExpression(node) {
      if (node.callee.type === 'MemberExpression' && !node.callee.computed
          && node.callee.object.name === timer.id.name && node.callee.property.name === 'dispose'
          && node.arguments.length === 0) cleanup.push(node);
    } });
    if (cleanup.length !== 1 || call.arguments[2].name !== fn.params[1].name)
      throw new Error('Shell environment deadline cleanup is incomplete');
    return { patched: true };
  }
  const cleanup = clears.filter(node => node.arguments.length === 1 && node.arguments[0].name === timer.id.name);
  if (cleanup.length !== 1) throw new Error('Shell environment deadline cleanup must have exactly one match');
  return { patched: false, call, cleanup: cleanup[0], timer: timer.id.name, log: fn.params[1].name };
}

export function patchShellEnvironmentSource(source) {
  const target = inspect(source);
  if (target.patched) return source;
  const { call, cleanup, timer, log } = target;
  const replacement = `(${HELPER})(${source.slice(call.arguments[0].start, call.arguments[0].end)},${source.slice(call.arguments[1].start, call.arguments[1].end)},${log})`;
  let result = source;
  for (const edit of [
    { start: call.start, end: call.end, text: replacement },
    { start: cleanup.start, end: cleanup.end, text: `${timer}.dispose()` },
  ].sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  inspect(result);
  return result;
}

const mainFile = paths => paths.mainJs || join(paths.appRoot, 'out', 'main.js');
export function checkShellEnvironment(paths, log) {
  patchShellEnvironmentSource(readFileSync(mainFile(paths), 'utf8'));
  log?.('[runtime-compat] Shell environment deadline and cleanup verified');
}
export function isShellEnvironmentPatched(paths) {
  const path = mainFile(paths);
  if (!existsSync(path)) return false;
  try { return inspect(readFileSync(path, 'utf8')).patched; } catch { return false; }
}
export function patchShellEnvironment(paths, log) {
  const path = mainFile(paths), original = readFileSync(path, 'utf8');
  const source = patchShellEnvironmentSource(original);
  if (source === original) return;
  createBackup(path, SHELL_ENV_TAG, log);
  writeFileSync(path, source);
  updateChecksums(paths, [path], SHELL_ENV_TAG, log);
  log?.('[runtime-compat] Patched shell environment deadline after main-loop stalls');
}
export function restoreShellEnvironment(paths, log) {
  for (const path of [paths.productJson, mainFile(paths)]) restoreBackup(path, SHELL_ENV_TAG, log);
}
