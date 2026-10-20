/**
 * 将 vsix 解压安装到 Cursor.app/extensions/cursor2plus/
 *
 * 使用 fflate (纯 JS, WASM 级性能) 解压，比 adm-zip 快 10x+。
 */
import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { installExtensionArchive } from './extension-archive.js';
const __pkgRoot = join(__dirname, '..');

export function installExtension(paths, log) {
  log?.('[extension] Installing to Cursor.app/extensions/cursor2plus/...');

  const vsixDir = join(__pkgRoot, 'vsix');
  const vsixFiles = existsSync(vsixDir) ? readdirSync(vsixDir).filter(f => f.endsWith('.vsix')) : [];

  if (vsixFiles.length === 0) {
    throw new Error('No .vsix file found in vsix/ directory. Run "npm run build" first.');
  }
  if (vsixFiles.length !== 1) {
    throw new Error('Multiple .vsix files found. Rebuild to select a single extension archive.');
  }

  const vsixPath = join(vsixDir, vsixFiles[0]);
  const targetDir = paths.cursor2plusDir;

  const count = installExtensionArchive(targetDir, vsixPath, log);

  log?.(`  Installed: ${targetDir} (${count} files)`);
  log?.(`  From: ${vsixFiles[0]}`);
}

export function removeExtension(paths, log) {
  if (existsSync(paths.cursor2plusDir)) {
    rmSync(paths.cursor2plusDir, { recursive: true, force: true });
    log?.('[extension] Removed cursor2plus from extensions/');
  } else {
    log?.('[extension] Not installed');
  }
}

export function isExtensionInstalled(paths) {
  return existsSync(join(paths.cursor2plusDir, 'package.json'));
}
