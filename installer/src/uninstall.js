/**
 * ccursor uninstall — full rollback
 *
 * Reverse order (opposite of install):
 *   -1. Restore runtime-compat (agent timeout defaults + retrieval punycode)
 *   0. Restore agent-host-gate group (product.json → workbench desktop/glass)
 *   1. Restore katex group (product.json → workbench.html)
 *   2. Restore proxy-39 group (product.json → alwaysLocalSingletonMain.js)
 *   3. Restore agent-host group (product.json → fingerprint-matched chunks → main.js)
 *   4. Restore always-local group (product.json → extensionHostProcess.js → always-local.js)
 *   5. Restore inject group (product.json → workbench.js)
 *   6. Remove extensions/cursor2plus/
 *
 * local-mode 是游离于主 installer 之外的特殊工具，
 * 只通过 `ccursor local-mode` / `ccursor local-mode-off` 管理。
 */
import { join } from 'path';
import { rmSync } from 'fs';
import { assertPlatformReady, withPlatformTransaction } from './platform-transaction.js';
import { INSTALLATION_MANIFEST } from './installation-state.js';
import { findCursorPathsDetailed, formatDiagnostic } from './detect.js';
import { restoreBackup } from './backup.js';
import { removeExtension } from './extension-embed.js';
import { getAgentHostBackupTargets } from './patch-agent-host.js';
import { restoreRuntimeCompat } from './patch-runtime-compat.js';

const ok = msg => console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
const info = msg => console.log(`\x1b[34m[>]\x1b[0m ${msg}`);
const warn = msg => console.log(`\x1b[33m[!]\x1b[0m ${msg}`);
const fail = msg => console.log(`\x1b[31m[X]\x1b[0m ${msg}`);

export async function uninstall() {
  info('Cursor++ BYOK Uninstaller');
  console.log('');

  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    fail('Cursor installation not found');
    console.log('');
    console.log(formatDiagnostic(diagnostic));
    console.log('');
    throw new Error('Cursor installation not found');
  }
  info(`Cursor: ${paths.appRoot}`);
  assertPlatformReady(paths);

  await withPlatformTransaction(paths, async (staged) => {
    let restored = 0;
    const workbenchHtml = join(staged.appRoot, 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.html');

    const singletonJs = join(staged.appRoot, 'out', 'vs', 'code', 'electron-utility', 'alwaysLocalSingleton', 'alwaysLocalSingletonMain.js');

    restoreRuntimeCompat(staged, info);

    // 0. 倒序恢复 agent-host-gate 组 (安装顺序最后 → 最先恢复)
    info('Restoring agent-host-gate patches...');
    for (const file of [staged.productJson, staged.workbenchJs, staged.glassJs]) {
      if (restoreBackup(file, 'agent-host-gate', info)) restored++;
    }

    // 1. 倒序恢复 katex 组
    info('Restoring katex patches...');
    for (const file of [staged.productJson, workbenchHtml]) {
      if (restoreBackup(file, 'katex', info)) restored++;
    }

    // 2. 倒序恢复 Cursor 3.9 proxy sync 组
    info('Restoring proxy-39 patches...');
    for (const file of [staged.productJson, singletonJs]) {
      if (restoreBackup(file, 'proxy-39', info)) restored++;
    }

    // 3. 倒序恢复独立 Agent Host transport 组
    info('Restoring agent-host patches...');
    for (const file of [staged.productJson, ...getAgentHostBackupTargets(staged)]) {
      if (restoreBackup(file, 'agent-host', info)) restored++;
    }

    // 4. 倒序恢复 always-local 组
    info('Restoring always-local patches...');
    for (const file of [staged.productJson, staged.extensionHostJs, staged.alwaysLocalMain]) {
      if (restoreBackup(file, 'always-local', info)) restored++;
    }

    // 5. 倒序恢复 inject 组 (glass → desktop → product.json, checksum 正确还原)
    info('Restoring inject patches...');
    for (const file of [staged.productJson, staged.glassJs, staged.workbenchJs]) {
      if (restoreBackup(file, 'inject', info)) restored++;
    }

    // 6. 删除扩展
    removeExtension(staged, info);

    rmSync(join(staged.appRoot, INSTALLATION_MANIFEST), { force: true });
    console.log('');
    if (restored > 0) {
      ok(`Restored ${restored} file(s)`);
    } else {
      warn('No backups found (already clean?)');
    }
  }, { log: info });
  ok('Uninstallation complete');
  warn('Restart Cursor for changes to take effect.');
}
