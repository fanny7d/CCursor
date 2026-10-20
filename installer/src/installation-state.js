import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';

export const INSTALLATION_MANIFEST = '.ccursor-installation.json';
export const digest = data => createHash('sha256').update(data).digest('hex');

export function appIdentity(file) {
  let root = dirname(file);
  while (true) {
    if (existsSync(join(root, 'product.json'))) {
      const product = JSON.parse(readFileSync(join(root, 'product.json'), 'utf8'));
      const pkg = existsSync(join(root, 'package.json')) ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) : {};
      return { root, version: pkg.version || 'unknown', commit: product.commit || null };
    }
    const parent = dirname(root);
    if (parent === root) return { root: dirname(file), version: 'unknown', commit: null };
    root = parent;
  }
}

function validateIdentity(record, identity) {
  if (record.cursorVersion !== identity.version || record.cursorCommit !== identity.commit)
    throw new Error('Cursor version/build differs from the backup. Restore a matching application before rollback.');
}

export function validateBackup(backup, file, { adoptLegacy = false } = {}) {
  const identity = appIdentity(file);
  const metadata = `${backup}.metadata.json`;
  if (existsSync(metadata)) {
    const record = JSON.parse(readFileSync(metadata, 'utf8'));
    validateIdentity(record, identity);
    if (record.originalHash !== digest(readFileSync(backup))) throw new Error('Backup checksum mismatch; refusing rollback');
    return;
  }
  // Older installations have no sidecars. Only adopt when every product backup
  // proves the same vendor build; never infer compatibility from filenames/dates.
  const productBackups = existsSync(identity.root) ? readdirSync(identity.root)
    .filter(name => name.startsWith('product.json.backup-byok-') && !name.endsWith('.metadata.json')) : [];
  if (!identity.commit || !productBackups.length || productBackups.some(name => {
    try { return JSON.parse(readFileSync(join(identity.root, name), 'utf8')).commit !== identity.commit; }
    catch { return true; }
  })) throw new Error('Unversioned legacy backups cannot be verified. Use the matching original installer or restore the full application backup.');
  if (adoptLegacy) writeBackupMetadata(backup, file);
}

export function writeBackupMetadata(backup, file) {
  const identity = appIdentity(file);
  writeFileSync(`${backup}.metadata.json`, JSON.stringify({ schemaVersion: 1, cursorVersion: identity.version, cursorCommit: identity.commit, originalHash: digest(readFileSync(backup)) }, null, 2), { mode: 0o600 });
}

export function validateInstallation(paths) {
  const file = join(paths.appRoot, INSTALLATION_MANIFEST);
  if (!existsSync(file)) return;
  const record = JSON.parse(readFileSync(file, 'utf8'));
  validateIdentity(record, appIdentity(paths.productJson));
  for (const [name, hash] of Object.entries(record.files || {})) {
    const target = join(paths.appRoot, name);
    if (relative(paths.appRoot, target).startsWith('..') || !existsSync(target) || digest(readFileSync(target)) !== hash)
      throw new Error('Installed application files changed since the last installation. Refusing to overwrite or restore a mixed build.');
  }
}

export function writeInstallationManifest(paths, files) {
  const identity = appIdentity(paths.productJson);
  const hashes = {};
  for (const file of files) {
    if (!file.includes('.backup-byok-') && !file.endsWith(INSTALLATION_MANIFEST))
      hashes[relative(paths.appRoot, file)] = digest(readFileSync(file));
  }
  writeFileSync(join(paths.appRoot, INSTALLATION_MANIFEST), JSON.stringify({ schemaVersion: 1,
    cursorVersion: identity.version, cursorCommit: identity.commit,
    installerVersion: process.env.CURSOR2PLUS_VERSION || 'development',
    build: process.env.CCURSOR_BUILD_SHA || 'development',
    localAccessProtocol: 1, files: hashes }, null, 2), { mode: 0o600 });
}
