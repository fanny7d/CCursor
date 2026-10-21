import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { CCURSOR_DIR } from './routes.js';
import { withInstallationTransaction, recoverInstallation } from './transaction.js';
import { assertCursorClosed, assertNativeCompatibility, inspectMacOSSignature, macOSBundle, signatureHealthy } from './macos-signing.js';
import { macOSJournal, recoverMacOSBundle, withMacOSBundleTransaction } from './macos-transaction.js';

export function assertPlatformReady(paths) {
  const bundle = macOSBundle(paths);
  if (!bundle) return;
  if (existsSync(macOSJournal(bundle))) throw new Error('Interrupted macOS installation exists. Quit Cursor and run "ccursor recover".');
  assertCursorClosed(bundle);
  assertNativeCompatibility(bundle, paths.cursorVersion);
}

export function platformSignatureNeedsRepair(paths) {
  const bundle = macOSBundle(paths);
  return bundle ? !signatureHealthy(inspectMacOSSignature(bundle)) : false;
}

export async function withPlatformTransaction(paths, prepare, options = {}) {
  if (!macOSBundle(paths)) return withInstallationTransaction(paths, async (staged, configDir) => {
    await prepare(staged, configDir);
    await options.validatePrepared?.(staged);
  }, options);
  return withMacOSBundleTransaction(paths, (staged, configDir) =>
    withInstallationTransaction(staged, prepare, { configDir }), options);
}

/** The current application may be absent after a kill between the two renames. */
export function recoverPlatformInstallation(paths, { configDir = CCURSOR_DIR } = {}) {
  if (process.platform === 'darwin') {
    const candidates = paths ? [macOSBundle(paths)] : process.env.CCURSOR_CURSOR_ROOT
      ? [macOSBundle({ appRoot: process.env.CCURSOR_CURSOR_ROOT })]
      : ['/Applications/Cursor.app', join(homedir(), 'Applications/Cursor.app')];
    const pending = candidates.filter(bundle => bundle && existsSync(macOSJournal(bundle)));
    if (pending.length > 1) throw new Error('Multiple macOS recoveries found; set CCURSOR_CURSOR_ROOT to the intended application.');
    if (pending.length === 1) return recoverMacOSBundle(pending[0], { configDir });
  }
  if (!paths) throw new Error('Cursor installation not found and no macOS recovery journal exists');
  recoverInstallation(paths, { configDir });
}
