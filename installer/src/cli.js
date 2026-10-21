import { doctor } from './doctor.js';
/**
 * ccursor CLI — Cursor++ BYOK Installer
 *
 * Usage:
 *   npx @cometix/ccursor install     # Install extension + apply patches
 *   npx @cometix/ccursor uninstall   # Remove extension + restore patches
 *   npx @cometix/ccursor status      # Check installation status
 */

import { install } from './install.js';
import { uninstall } from './uninstall.js';
import { status } from './status.js';
import { check } from './check.js';
import { findCursorPathsDetailed, formatDiagnostic } from './detect.js';
import { patchLocalMode } from './patch-local-mode.js';
import { recoverPlatformInstallation } from './platform-transaction.js';
import { verifyInstalledApplication } from './verify.js';
import { restoreBackup } from './backup.js';

async function update() {
  await install({ refreshExtension: true });
}

const command = process.argv[2];

const commands = {
  install,
  uninstall,
  update,
  upgrade: update,
  repair: update,
  status,
  doctor: async () => {
    const index = process.argv.indexOf('--output');
    if (index !== -1 && !process.argv[index + 1]) throw new Error('--output requires a new file path');
    await doctor({ output: index === -1 ? undefined : process.argv[index + 1] });
  },
  recover: async () => {
    const { paths, diagnostic } = findCursorPathsDetailed();
    recoverPlatformInstallation(paths);
    console.log('Installation restored to its previous state.');
  },
  check,
  verify: async () => {
    const { paths, diagnostic } = findCursorPathsDetailed();
    if (!paths) throw new Error(formatDiagnostic(diagnostic));
    await check(paths);
    verifyInstalledApplication(paths);
    console.log('Installed patches, Cursor build and platform signature verified. Run a real Agent task to verify the upstream route.');
  },
  'local-mode': async () => {
    const info = msg => console.log(`\x1b[34m[>]\x1b[0m ${msg}`);
    const { paths, diagnostic } = findCursorPathsDetailed();
    if (!paths) { console.log(formatDiagnostic(diagnostic)); process.exit(1); }
    info(`Cursor: ${paths.appRoot}`);
    patchLocalMode(paths, info);
  },
  'local-mode-off': async () => {
    const info = msg => console.log(`\x1b[34m[>]\x1b[0m ${msg}`);
    const { paths, diagnostic } = findCursorPathsDetailed();
    if (!paths) { console.log(formatDiagnostic(diagnostic)); process.exit(1); }
    info(`Cursor: ${paths.appRoot}`);
    info('Restoring local-mode patches...');
    let restored = 0;
    const { join } = await import('path');
    const targets = [
      'out/main.js',
      'out/vs/workbench/workbench.desktop.main.js',
      'out/vs/workbench/workbench.glass.main.js',
      'out/vs/workbench/api/node/extensionHostProcess.js',
      'out/vs/code/electron-utility/alwaysLocalSingleton/alwaysLocalSingletonMain.js',
    ];
    for (const rel of targets) {
      if (restoreBackup(join(paths.appRoot, rel), 'local-mode', info)) restored++;
    }
    if (restoreBackup(paths.productJson, 'local-mode', info)) restored++;
    console.log(restored > 0 ? `\x1b[32m[OK]\x1b[0m Restored ${restored} file(s)` : '\x1b[33m[!]\x1b[0m No backups found');
  },
  help: async () => {
    console.log(`
ccursor — Cursor++ BYOK Installer

Commands:
  install          Install Cursor++ extension and apply patches
  uninstall        Remove extension and restore all patches
  update           Check compatibility and refresh the extension, preserving configuration
  upgrade          Alias for update
  repair           Recheck patches and repair macOS signing using the update transaction
  local-mode       Standalone tool: enable Cursor's built-in Local Agent mode
  local-mode-off   Standalone tool: disable Local Agent mode (restore originals)
  doctor           Print a sanitized JSON report (--output NEW_FILE to save)
  recover          Recover an interrupted installation (close Cursor first)
  status           Check current installation status
  check            Dry-run: verify AST patch targets are matchable
  verify           Read-only: require installed patches, matching build and valid macOS signature
  help             Show this help message
`);
  },
};

const fn = commands[command];
if (!fn) {
  console.error(`Unknown command: ${command || '(none)'}`);
  commands.help();
  process.exit(1);
}

fn().catch(err => {
  console.error(`\n\x1b[31m[ERROR]\x1b[0m ${err.message}`);
  process.exit(1);
});
