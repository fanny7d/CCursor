/** Prepare every patch in a private mirror, then commit with a recovery journal. */
import { randomUUID } from 'crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, relative } from 'path';
import { CCURSOR_DIR } from './routes.js';
import { digest, INSTALLATION_MANIFEST, validateBackup, validateInstallation } from './installation-state.js';

export const JOURNAL_FILE = '.ccursor-transaction.json';
export const CONFIG_FILES = ['routes.json', 'providers.json', 'web-tools.json', 'models-catalog.json', 'local-access.json'];

function inside(root, path) {
  const name = relative(root, path);
  return name !== '..' && !name.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(name);
}

export function treeFiles(root) {
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink()) throw new Error('Refusing symlinked installation targets');
  if (!statSync(root).isDirectory()) return [root];
  return readdirSync(root).sort().flatMap(name => treeFiles(join(root, name)));
}

function hashPath(path) {
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) throw new Error('Refusing symlinked installation targets');
  if (!statSync(path).isDirectory()) return digest(readFileSync(path));
  return digest(JSON.stringify(treeFiles(path).map(file => [relative(path, file), digest(readFileSync(file))])));
}

/** Include every patch input, version file, output and group-scoped backup. */
export function applicationFiles(paths) {
  const files = new Set(Object.values(paths).filter(value => typeof value === 'string' && inside(paths.appRoot, value) && existsSync(value) && !statSync(value).isDirectory()));
  for (const name of ['package.json', 'product.json', INSTALLATION_MANIFEST,
    'extensions/cursor-agent-host/package.json', 'extensions/cursor-retrieval/dist/main.js',
    'out/vs/code/electron-sandbox/workbench/workbench.html', 'extensions/markdown-math/notebook-out/katex.min.css']) {
    const path = join(paths.appRoot, name);
    if (existsSync(path)) files.add(path);
  }
  if (paths.agentHostDist && existsSync(paths.agentHostDist)) {
    for (const name of readdirSync(paths.agentHostDist))
      if (name.endsWith('.js')) files.add(join(paths.agentHostDist, name));
  }
  for (const file of [...files]) {
    for (const name of readdirSync(dirname(file)))
      if (name.startsWith(`${basename(file)}.backup-byok-`)) files.add(join(dirname(file), name));
  }
  return [...files].filter(file => !inside(paths.cursor2plusDir, file));
}

function copyPrivate(source, target) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (lstatSync(source).isSymbolicLink()) throw new Error('Refusing symlinked installation targets');
  cpSync(source, target, { recursive: true, preserveTimestamps: true });
}

function replace(target, source, mode, locations = {}) {
  if (!source) {
    rmSync(target, { recursive: true, force: true });
    return;
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const staging = locations.staging || join(dirname(target), `.ccursor-new-${randomUUID()}`);
  const previous = locations.previous || join(dirname(target), `.ccursor-old-${randomUUID()}`);
  let moved = false;
  try {
    cpSync(source, staging, { recursive: true, preserveTimestamps: true });
    chmodSync(staging, mode);
    if (statSync(staging).isDirectory() && existsSync(target)) {
      renameSync(target, previous);
      moved = true;
    }
    try { renameSync(staging, target); }
    catch (error) {
      if (moved) renameSync(previous, target);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });
  }
  finally { rmSync(staging, { recursive: true, force: true }); }
}

function cleanupOperationTemps(op) {
  for (const name of ['staging', 'previous']) {
    if (op[name]) rmSync(op[name], { recursive: true, force: true });
  }
}

function restoreOperations(record, operations = record.operations, checkConcurrent = false) {
  for (const op of [...operations].reverse()) {
    if (checkConcurrent) {
      const current = hashPath(op.target);
      if (current === op.before) { cleanupOperationTemps(op); continue; }
      if (current !== op.after) throw new Error('A concurrent edit prevents automatic recovery');
    }
    if (op.original && hashPath(op.original) !== op.before) throw new Error('Recovery snapshot checksum mismatch');
    cleanupOperationTemps(op);
    replace(op.target, op.original, op.mode, op);
    cleanupOperationTemps(op);
  }
  if (!record.configExisted && existsSync(record.configDir) && !readdirSync(record.configDir).length)
    rmSync(record.configDir, { recursive: true });
}

export function recoverInstallation(paths, { configDir = CCURSOR_DIR } = {}) {
  const marker = join(paths.appRoot, JOURNAL_FILE);
  if (!existsSync(marker)) throw new Error('No interrupted installation to recover');
  const { workspace } = JSON.parse(readFileSync(marker, 'utf8'));
  if (typeof workspace !== 'string' || !inside(tmpdir(), workspace)) throw new Error('Invalid recovery workspace');
  const record = JSON.parse(readFileSync(join(workspace, 'recovery.json'), 'utf8'));
  if (record.appRoot !== paths.appRoot || record.configDir !== configDir || !Array.isArray(record.operations)) throw new Error('Recovery target mismatch');
  for (const op of record.operations) {
    if ((!inside(paths.appRoot, op.target) && !inside(configDir, op.target)) || (op.original && !inside(workspace, op.original))) throw new Error('Invalid recovery path');
    for (const name of ['staging', 'previous']) {
      if (op[name] && (dirname(op[name]) !== dirname(op.target) || !/^\.ccursor-(?:new|old)-[a-f0-9-]{36}$/.test(basename(op[name])))) throw new Error('Invalid recovery temporary path');
    }
  }
  restoreOperations(record);
  rmSync(marker);
  rmSync(workspace, { recursive: true, force: true });
}

export async function withInstallationTransaction(paths, prepare, { configDir = CCURSOR_DIR, beforeCommit } = {}) {
  const marker = join(paths.appRoot, JOURNAL_FILE);
  if (existsSync(marker)) throw new Error('An interrupted installation exists. Close Cursor and run "ccursor recover" first.');
  validateInstallation(paths);
  const workspace = mkdtempSync(join(tmpdir(), 'ccursor-transaction-'));
  const stageApp = join(workspace, 'prepared-app');
  const stageConfig = join(workspace, 'prepared-config');
  const originalConfigExisted = existsSync(configDir);
  let retain = false;
  try {
    mkdirSync(stageApp, { recursive: true });
    mkdirSync(stageConfig);
    const initial = applicationFiles(paths);
    const baseline = new Map();
    function stageInput(source, target) {
      const hash = hashPath(source);
      const original = join(workspace, 'original', String(baseline.size));
      copyPrivate(source, original);
      if (hashPath(original) !== hash || hashPath(source) !== hash) throw new Error('Installation input changed while snapshotting');
      copyPrivate(original, target);
      baseline.set(source, { hash, original, mode: statSync(source).mode & 0o777 });
    }
    for (const file of initial) stageInput(file, join(stageApp, relative(paths.appRoot, file)));
    if (existsSync(paths.cursor2plusDir)) stageInput(paths.cursor2plusDir, join(stageApp, relative(paths.appRoot, paths.cursor2plusDir)));
    for (const name of CONFIG_FILES) {
      const source = join(configDir, name);
      if (existsSync(source)) stageInput(source, join(stageConfig, name));
    }
    const staged = Object.fromEntries(Object.entries(paths).map(([name, value]) => [name,
      typeof value === 'string' && inside(paths.appRoot, value) ? join(stageApp, relative(paths.appRoot, value)) : value]));
    // Adopt verified legacy backup metadata before any restore removes the
    // original product.json backup that proves its vendor build identity.
    for (const file of initial) {
      if (file.includes('.backup-byok-') && !file.endsWith('.metadata.json')) {
        const backup = join(stageApp, relative(paths.appRoot, file));
        validateBackup(backup, backup.split('.backup-byok-')[0], { adoptLegacy: true });
      }
    }
    await prepare(staged, stageConfig);

    const names = new Set(initial.map(file => relative(paths.appRoot, file)));
    for (const file of applicationFiles(staged)) names.add(relative(stageApp, file));
    // An uninstall may remove the manifest; an install may create it.
    names.add(INSTALLATION_MANIFEST);
    const candidates = [...names].map(name => ({ target: join(paths.appRoot, name), source: join(stageApp, name) }));
    candidates.push({ target: paths.cursor2plusDir, source: staged.cursor2plusDir });
    candidates.push(...CONFIG_FILES.map(name => ({ target: join(configDir, name), source: join(stageConfig, name) })));
    const operations = [];
    for (const { target, source } of candidates) {
      const before = baseline.get(target)?.hash ?? null, after = hashPath(source);
      if (before === after) continue;
      const original = baseline.get(target)?.original ?? null;
      operations.push({ target, source: after === null ? null : source, original, before, after,
        staging: join(dirname(target), `.ccursor-new-${randomUUID()}`), previous: join(dirname(target), `.ccursor-old-${randomUUID()}`),
        mode: baseline.get(target)?.mode ?? (existsSync(source) ? statSync(source).mode & 0o777 : 0o600) });
    }
    const record = { schemaVersion: 1, appRoot: paths.appRoot, configDir, configExisted: originalConfigExisted, operations };
    writeFileSync(join(workspace, 'recovery.json'), JSON.stringify(record), { mode: 0o600 });
    // Compare again immediately before commit: never overwrite a concurrent edit.
    for (const [target, original] of baseline)
      if (hashPath(target) !== original.hash) throw new Error('Installation inputs changed during preparation');
    for (const op of operations)
      if (hashPath(op.target) !== op.before) throw new Error('Installation targets changed during preparation');
    writeFileSync(marker, JSON.stringify({ schemaVersion: 1, workspace }), { mode: 0o600, flag: 'wx' });
    const applied = [];
    try {
      for (const [index, op] of operations.entries()) {
        beforeCommit?.(index, op.target);
        if (hashPath(op.target) !== op.before) throw new Error('Installation target changed during commit');
        applied.push(op);
        replace(op.target, op.source, op.mode, op);
      }
      rmSync(marker);
    }
    catch (error) {
      try {
        restoreOperations(record, applied, true);
        rmSync(marker);
      }
      catch (rollbackError) {
        retain = true;
        throw new AggregateError([error, rollbackError], 'Installation failed and recovery is incomplete. Close Cursor and run "ccursor recover".');
      }
      throw error;
    }
    return operations.length;
  }
  finally {
    if (!retain) rmSync(workspace, { recursive: true, force: true });
  }
}
