import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { CCURSOR_DIR } from './routes.js';
import { appIdentity, INSTALLATION_MANIFEST, validateInstallation } from './installation-state.js';

export const INSTALLATION_RECEIPT = 'installation-receipt.json';
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(value) ? value : 'unknown';

export function compatibilityState(paths, { configDir = CCURSOR_DIR } = {}) {
  const current = appIdentity(paths.productJson || join(paths.appRoot, 'product.json'));
  let receipt;
  try { receipt = JSON.parse(readFileSync(join(configDir, INSTALLATION_RECEIPT), 'utf8')); } catch {}
  const result = { state: 'not-installed', currentCursorVersion: version(current.version), previousCursorVersion: version(receipt?.cursorVersion) };
  if (existsSync(join(paths.appRoot, INSTALLATION_MANIFEST))) {
    try { validateInstallation(paths); result.state = 'installed'; }
    catch { result.state = 'modified-or-mixed-build'; }
  } else if (receipt?.installed === true) {
    result.state = receipt.cursorVersion !== current.version || receipt.cursorCommit !== current.commit ? 'cursor-updated' : 'installation-removed';
  }
  return result;
}
