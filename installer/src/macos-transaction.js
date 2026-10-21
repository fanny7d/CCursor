/** Full-bundle swap: recovery records live outside the signed resource envelope. */
import { createHash, randomUUID } from 'crypto';
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, renameSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { CONFIG_FILES } from './transaction.js';
import { CCURSOR_DIR } from './routes.js';
import { appIdentity, INSTALLATION_MANIFEST, validateInstallation } from './installation-state.js';
import { INSTALLATION_RECEIPT } from './compatibility-state.js';
import { assertBundleLayout, assertCursorClosed, assertNativeCompatibility, copyMacOSBundle, macOSBundle, nativeCommand, signMacOSBundle, inspectMacOSSignature, signatureHealthy } from './macos-signing.js';

const configNames = [...CONFIG_FILES, INSTALLATION_RECEIPT];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const macOSJournal = bundle => join(dirname(bundle), `.${basename(bundle)}.ccursor-recovery.json`);
const backupRoot = bundle => join(dirname(bundle), `.${basename(bundle)}.ccursor-backups`);

/** Includes modes and symlink targets; reads large native binaries in bounded chunks. */
export function bundleDigest(root) {
  if (!existsSync(root) && !lstatIfPresent(root)) return null;
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  function visit(path) {
    const stat = lstatSync(path);
    hash.update(JSON.stringify([relative(root, path), stat.mode & 0o777, stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file']));
    if (stat.isSymbolicLink()) { hash.update(readlinkSync(path)); return; }
    if (stat.isDirectory()) { for (const name of readdirSync(path).sort()) visit(join(path, name)); return; }
    if (!stat.isFile()) throw new Error('Unsupported special file in application transaction');
    hash.update(String(stat.size));
    const fd = openSync(path, 'r');
    try { let n; while ((n = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
    finally { closeSync(fd); }
  }
  visit(root);
  return hash.digest('hex');
}
function lstatIfPresent(path) { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function rejectLink(path) { if (lstatIfPresent(path)?.isSymbolicLink()) throw new Error('Refusing symlinked macOS transaction paths'); }
function readJSON(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function layout(bundle, id) {
  const workspace = join(backupRoot(bundle), id);
  return { workspace, original: join(workspace, 'original.app'), prepared: join(workspace, 'prepared.app'),
    originalConfig: join(workspace, 'original-config'), preparedConfig: join(workspace, 'prepared-config'), recovery: join(workspace, 'recovery.json') };
}
function mappedPaths(paths, bundle, prepared) {
  return Object.fromEntries(Object.entries(paths).map(([name, value]) => [name,
    typeof value === 'string' && (value === paths.appRoot || value.startsWith(`${paths.appRoot}${sep}`)) ? join(prepared, relative(bundle, value)) : value]));
}
function atomicConfig(source, target, id, mode) {
  if (!source) { rmSync(target, { force: true }); return; }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = join(dirname(target), `.${basename(target)}.ccursor-${id}`);
  rejectLink(temp);
  try { copyFileSync(source, temp); chmodSync(temp, mode); renameSync(temp, target); }
  finally { rmSync(temp, { force: true }); }
}

function validateRecord(record, bundle, configDir, locations) {
  if (record.schemaVersion !== 1 || record.bundle !== bundle || record.configDir !== configDir || !uuid.test(record.id) ||
      !/^[a-f0-9]{64}$/.test(record.before) || !/^[a-f0-9]{64}$/.test(record.after) || !Array.isArray(record.config)) throw new Error('Invalid macOS recovery record');
  for (const dir of [backupRoot(bundle), locations.workspace, locations.originalConfig, locations.preparedConfig, configDir]) rejectLink(dir);
  const names = new Set();
  for (const op of record.config) {
    if (!configNames.includes(op.name) || names.has(op.name) || ![op.before, op.after].every(h => h === null || /^[a-f0-9]{64}$/.test(h)) || ![op.mode, op.beforeMode].every(m => Number.isInteger(m) && m >= 0 && m <= 0o777)) throw new Error('Invalid macOS recovery configuration record');
    names.add(op.name);
    rejectLink(join(configDir, op.name));
    rejectLink(join(locations.originalConfig, op.name));
  }
}

function rollback(record, locations) {
  const { bundle, configDir, id } = record;
  const current = bundleDigest(bundle), original = bundleDigest(locations.original);
  if (current !== null && current !== record.before && current !== record.after) throw new Error('Concurrent Cursor update prevents automatic recovery');
  if (current !== record.before && original !== record.before) throw new Error('Original macOS bundle snapshot is missing or corrupt');
  // Validate all snapshots before overwriting any user data.
  for (const op of record.config) {
    const hash = bundleDigest(join(configDir, op.name));
    if (hash !== op.before && hash !== op.after) throw new Error('Concurrent configuration edit prevents automatic recovery');
    if (op.before !== null && bundleDigest(join(locations.originalConfig, op.name)) !== op.before) throw new Error('Original configuration snapshot is corrupt');
  }
  for (const op of [...record.config].reverse()) {
    const target = join(configDir, op.name);
    if (bundleDigest(target) !== op.before) atomicConfig(op.before === null ? null : join(locations.originalConfig, op.name), target, id, op.beforeMode);
    rmSync(join(configDir, `.${op.name}.ccursor-${id}`), { force: true });
  }
  if (current !== record.before) {
    if (current !== null) renameSync(bundle, join(locations.workspace, 'failed.app'));
    renameSync(locations.original, bundle);
  }
  if (!record.configExisted && existsSync(configDir) && readdirSync(configDir).length === 0) rmSync(configDir);
}

export function recoverMacOSBundle(bundle, { configDir = CCURSOR_DIR, run = nativeCommand } = {}) {
  bundle = resolve(bundle); configDir = resolve(configDir);
  const journal = macOSJournal(bundle);
  if (!existsSync(journal)) return false;
  rejectLink(journal);
  const marker = readJSON(journal);
  if (!uuid.test(marker.id)) throw new Error('Invalid macOS recovery marker');
  const locations = layout(bundle, marker.id);
  rejectLink(backupRoot(bundle)); rejectLink(locations.workspace); rejectLink(locations.recovery);
  const record = readJSON(locations.recovery);
  if (record.id !== marker.id) throw new Error('macOS recovery transaction mismatch');
  validateRecord(record, bundle, configDir, locations);
  assertCursorClosed(bundle, run);
  rollback(record, locations);
  rmSync(journal);
  rmSync(locations.workspace, { recursive: true, force: true });
  return true;
}

export async function withMacOSBundleTransaction(paths, prepare, { configDir = CCURSOR_DIR, run = nativeCommand,
  log = () => {}, beforeCommit, afterPrepare, validatePrepared = () => {} } = {}) {
  const bundle = macOSBundle(paths, 'darwin');
  if (!bundle) throw new Error('Unsupported macOS bundle path');
  configDir = resolve(configDir);
  assertBundleLayout(bundle);
  assertCursorClosed(bundle, run);
  if (existsSync(macOSJournal(bundle))) throw new Error('Interrupted macOS installation exists. Quit Cursor and run "ccursor recover".');
  validateInstallation(paths);
  const identity = appIdentity(paths.productJson);
  if (identity.version !== paths.cursorVersion) throw new Error('Cursor updated during detection; rerun compatibility check');
  assertNativeCompatibility(bundle, paths.cursorVersion, run);
  for (const dir of [backupRoot(bundle), configDir]) rejectLink(dir);
  const id = randomUUID(), locations = layout(bundle, id);
  mkdirSync(locations.workspace, { recursive: true, mode: 0o700 });
  chmodSync(backupRoot(bundle), 0o700);
  const baseline = bundleDigest(bundle), configExisted = existsSync(configDir);
  let journalOwned = false, committed = false, retain = false;
  try {
    copyMacOSBundle(bundle, locations.prepared, run);
    assertNativeCompatibility(locations.prepared, paths.cursorVersion, run);
    if (bundleDigest(locations.prepared) !== baseline || bundleDigest(bundle) !== baseline) throw new Error('Cursor changed while copying the application; rerun after the official update finishes');
    mkdirSync(locations.originalConfig, { mode: 0o700 });
    mkdirSync(locations.preparedConfig, { mode: 0o700 });
    const before = new Map();
    for (const name of configNames) {
      const file = join(configDir, name);
      rejectLink(file);
      before.set(name, bundleDigest(file));
      if (existsSync(file)) {
        copyFileSync(file, join(locations.originalConfig, name));
        chmodSync(join(locations.originalConfig, name), lstatSync(file).mode & 0o777);
        cpSync(join(locations.originalConfig, name), join(locations.preparedConfig, name));
        if (bundleDigest(join(locations.originalConfig, name)) !== before.get(name)) throw new Error('Configuration changed while snapshotting');
      }
    }
    const staged = mappedPaths(paths, bundle, locations.prepared);
    await prepare(staged, locations.preparedConfig);
    await validatePrepared(staged);
    validateInstallation(staged);
    const installed = existsSync(join(staged.appRoot, INSTALLATION_MANIFEST));
    const state = { schemaVersion: 1, cursorVersion: identity.version, cursorCommit: identity.commit, installed,
      installerVersion: process.env.CURSOR2PLUS_VERSION || 'development', build: process.env.CCURSOR_BUILD_SHA || 'development' };
    writeFileSync(join(locations.preparedConfig, INSTALLATION_RECEIPT), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    signMacOSBundle(locations.prepared, locations.workspace, { run, log });
    validateInstallation(staged);
    const after = bundleDigest(locations.prepared);
    const operations = configNames.flatMap(name => {
      const source = join(locations.preparedConfig, name);
      rejectLink(source);
      const next = bundleDigest(source);
      return before.get(name) === next ? [] : [{ name, before: before.get(name), after: next,
        mode: existsSync(source) ? lstatSync(source).mode & 0o777 : 0o600,
        beforeMode: existsSync(join(locations.originalConfig, name)) ? lstatSync(join(locations.originalConfig, name)).mode & 0o777 : 0o600 }];
    });
    const record = { schemaVersion: 1, id, bundle, configDir, configExisted, before: baseline, after, config: operations };
    writeFileSync(locations.recovery, JSON.stringify(record), { mode: 0o600 });
    await afterPrepare?.(staged);
    assertCursorClosed(bundle, run);
    if (bundleDigest(bundle) !== baseline) throw new Error('Cursor changed during preparation; original application preserved');
    for (const name of configNames)
      if (bundleDigest(join(configDir, name)) !== before.get(name)) throw new Error('Configuration changed during preparation; user edits preserved');
    writeFileSync(macOSJournal(bundle), JSON.stringify({ schemaVersion: 1, id }), { mode: 0o600, flag: 'wx' });
    journalOwned = true;
    try {
      await beforeCommit?.('before-app-move');
      renameSync(bundle, locations.original);
      await beforeCommit?.('after-app-move');
      renameSync(locations.prepared, bundle);
      await beforeCommit?.('after-app-replace');
      for (const op of operations) {
        await beforeCommit?.(`config:${op.name}`);
        const target = join(configDir, op.name);
        rejectLink(target);
        if (bundleDigest(target) !== op.before) throw new Error('Configuration changed during commit');
        atomicConfig(op.after === null ? null : join(locations.preparedConfig, op.name), target, id, op.mode);
      }
      await beforeCommit?.('after-config');
      if (bundleDigest(bundle) !== after) throw new Error('Cursor changed during commit');
      if (!signatureHealthy(inspectMacOSSignature(bundle, { run }))) throw new Error('Installed macOS signature is invalid');
      validateInstallation(paths);
      assertNativeCompatibility(bundle, paths.cursorVersion, run);
      for (const op of operations)
        if (bundleDigest(join(configDir, op.name)) !== op.after) throw new Error('Configuration changed during commit verification');
      await beforeCommit?.('verified');
      rmSync(macOSJournal(bundle));
      journalOwned = false;
      committed = true;
      log(`macOS: signed bundle verified. Previous application/configuration retained at ${locations.workspace}`);
    } catch (error) {
      try { rollback(record, locations); rmSync(macOSJournal(bundle)); journalOwned = false; }
      catch (rollbackError) { retain = true; throw new AggregateError([error, rollbackError], 'macOS installation interrupted; recovery retained. Quit Cursor and run "ccursor recover".'); }
      throw error;
    }
    // Retain original configuration for rollback; discard the prepared duplicates.
    rmSync(locations.preparedConfig, { recursive: true, force: true });
    rmSync(join(locations.workspace, 'local-entitlements.plist'), { force: true });
    return operations.length + 1;
  } finally {
    if (!retain && !committed && !journalOwned) rmSync(locations.workspace, { recursive: true, force: true });
  }
}
