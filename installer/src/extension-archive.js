/** Validate and stage a VSIX before replacing a working extension. */
import { unzipSync } from 'fflate';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';

export function readExtensionArchive(vsixPath) {
  const archive = unzipSync(new Uint8Array(readFileSync(vsixPath)));
  const files = new Map();
  for (const [name, data] of Object.entries(archive)) {
    if (!name.startsWith('extension/') || name.endsWith('/')) continue;
    const relative = name.slice('extension/'.length);
    // Reject both POSIX and Windows escape paths, on every host platform.
    if (/[\\:]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Unsafe VSIX entry: ${name}`);
    }
    files.set(relative, data);
  }

  const manifestData = files.get('package.json');
  if (!manifestData) throw new Error('VSIX is missing extension/package.json');
  const manifest = JSON.parse(Buffer.from(manifestData).toString('utf8'));
  if (manifest.name !== 'cursor2plus') throw new Error('VSIX is not a cursor2plus extension');
  const main = typeof manifest.main === 'string' ? manifest.main.replace(/^\.\//, '') : '';
  if (!main || !files.has(main)) throw new Error('VSIX extension entry point is missing');
  return files;
}

export function installExtensionArchive(targetDir, vsixPath, log) {
  // Read, decompress and validate before touching the installed directory.
  const files = readExtensionArchive(vsixPath);
  mkdirSync(dirname(targetDir), { recursive: true });
  const stagingRoot = mkdtempSync(join(dirname(targetDir), `.${basename(targetDir)}-install-`));
  const stagedDir = join(stagingRoot, 'new');
  const previousDir = join(stagingRoot, 'previous');
  let movedPrevious = false;
  try {
    for (const [relative, data] of files) {
      const dest = join(stagedDir, relative);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
    }
    if (existsSync(targetDir)) {
      renameSync(targetDir, previousDir);
      movedPrevious = true;
    }
    try {
      renameSync(stagedDir, targetDir);
    } catch (error) {
      if (movedPrevious) renameSync(previousDir, targetDir);
      throw error;
    }
  } finally {
    // If restoring itself fails, retain the previous directory for recovery.
    if (movedPrevious && !existsSync(targetDir)) {
      log?.(`  Previous extension retained for recovery: ${previousDir}`);
    } else {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
  return files.size;
}
