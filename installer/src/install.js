/**
 * ccursor install — 完整安装流程
 *
 * 顺序：
 *   0. 定位 Cursor 安装目录 + 预检
 *   1. 释放默认配置到 ~/.ccursor/
 *   2. 安装扩展到 extensions/cursor2plus/
 *   3. 注入 renderer hook (workbench.js)
 *   4. 注入 always-local 拦截 + 签名绕过 + 优先加载 (extensionHostProcess.js)
 *   5. 注入 cursor-agent-host 独立 HTTP/1.1 transport 拦截并禁用 WebSocket
 *   6. Cursor 3.9+ always-local singleton BYOK router + HTTP/1.1 proxy 修补
 *   7. KaTeX CSS link 修补 (workbench.html)
 *   8. Cursor 3.23+ 强制关闭 cursor_agent_host 门闩 (退回 legacy Agent 拓扑)
 *   9. 提示重启
 */
import { existsSync, readFileSync } from 'fs';
import { findCursorPathsDetailed, formatDiagnostic } from './detect.js';
import { installExtension, isExtensionInstalled } from './extension-embed.js';
import { hasBackup } from './backup.js';
import { isInjectPatched, patchInject } from './patch-inject.js';
import { inspectAlwaysLocalPatch, patchAlwaysLocal } from './patch-always-local.js';
import { getAgentHostBackupTargets, isAgentHostPatched, patchAgentHost } from './patch-agent-host.js';
import { patchKatex } from './patch-katex.js';
import { patchProxy39, needsProxy39Patch, isProxy39Patched } from './patch-proxy-39.js';
import { patchAgentHostGate, isAgentHostGateFullyPatched } from './patch-agent-host-gate.js';
import { patchRuntimeCompat, isRuntimeCompatPatched } from './patch-runtime-compat.js';
import { check } from './check.js';
// delete-fix 已移除 — 3.2.11 原生 tombstoneDeletedComposer 已覆盖
import { releaseDefaults } from './release-defaults.js';
import { applicationFiles, treeFiles } from './transaction.js';
import { assertPlatformReady, platformSignatureNeedsRepair, withPlatformTransaction } from './platform-transaction.js';
import { validateInstallation, writeInstallationManifest } from './installation-state.js';
import { verifyPreparedInstallation } from './verify.js';
import { loadRoutes } from './routes.js';
import { join } from 'path';

const ok = msg => console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
const info = msg => console.log(`\x1b[34m[>]\x1b[0m ${msg}`);
const warn = msg => console.log(`\x1b[33m[!]\x1b[0m ${msg}`);
const fail = msg => console.log(`\x1b[31m[X]\x1b[0m ${msg}`);

export async function install({ refreshExtension = false } = {}) {
  info('Cursor++ BYOK Installer');
  console.log('');

  // 0. 定位 + 预检
  const { paths, diagnostic } = findCursorPathsDetailed();
  if (!paths) {
    fail('Cursor installation not found');
    console.log('');
    console.log(formatDiagnostic(diagnostic));
    console.log('');
    throw new Error('Cursor installation not found');
  }
  info(`Cursor: ${paths.appRoot}`);
  info(`Version: ${paths.cursorVersion}${paths.hasGlass ? ' (glass)' : ''}`);
  assertPlatformReady(paths);
  // Run supported compatibility checks before defaults, extension files or
  // application bundles are changed. A failed check rejects the install.
  await check();
  validateInstallation(paths);

  const extInstalled = isExtensionInstalled(paths);
  const desktopPatched = existsSync(paths.workbenchJs) && isInjectPatched(readFileSync(paths.workbenchJs, 'utf-8'));
  const glassPatched = !existsSync(paths.glassJs) || isInjectPatched(readFileSync(paths.glassJs, 'utf-8'));
  const hookInjected = desktopPatched && glassPatched;
  const alPatched = inspectAlwaysLocalPatch(paths).fullyPatched;
  const agentHostPatched = isAgentHostPatched(paths);
  const proxy39Ok = !needsProxy39Patch(paths) || isProxy39Patched(paths);
  const agentGateOk = isAgentHostGateFullyPatched(paths);
  const agentHostBackups = getAgentHostBackupTargets(paths).some(file => hasBackup(file, 'agent-host'));
  const hasBackups = hasBackup(paths.workbenchJs) || hasBackup(paths.glassJs) || hasBackup(paths.alwaysLocalMain)
    || hasBackup(paths.alwaysLocalSingletonJs) || hasBackup(paths.extensionHostJs) || agentHostBackups;

  if (extInstalled && hookInjected && alPatched && agentHostPatched && proxy39Ok && agentGateOk && isRuntimeCompatPatched(paths)) {
    if (refreshExtension || platformSignatureNeedsRepair(paths)) {
      await withPlatformTransaction(paths, async (staged) => {
        if (refreshExtension) installExtension(staged, info);
        writeInstallationManifest(staged, [...applicationFiles(staged), ...treeFiles(staged.cursor2plusDir)]);
      }, { log: info, validatePrepared: verifyPreparedInstallation });
      ok('Application verified; patches and configuration preserved');
      warn('Restart Cursor for changes to take effect.');
      return;
    }
    ok('Already fully installed');
    info('To refresh the extension, run "ccursor update"');
    return;
  }

  if (hasBackups && !extInstalled) {
    warn('Found backup files from a previous installation');
    warn('Run "ccursor uninstall" to clean up before reinstalling');
    throw new Error('Existing backups require recovery before installing the missing extension');
  }

  console.log('');

  // 1. 释放默认配置到 ~/.ccursor/ (尊重已有用户文件)
  await withPlatformTransaction(paths, async (staged, configDir) => {
    releaseDefaults(info, { configDir });
    staged.routesConfig = loadRoutes(join(configDir, 'routes.json'));

    // 2. 安装扩展
    installExtension(staged, info);

    // 3. Inject renderer hook
    patchInject(staged, info);

    // 4. Always-local + sig bypass
    patchAlwaysLocal(staged, info);

    // 5. Independent Agent Host transport (3.13+)
    patchAgentHost(staged, info);

    // 6. Cursor 3.9+ always-local singleton BYOK router + HTTP/1.1 proxy sync
    patchProxy39(staged, info);

    // 7. KaTeX CSS link (workbench.html + checksum)
    patchKatex(staged, info);

    // 8. Cursor 3.23+ Agent Host 门闩强制关闭 (恢复 legacy 拓扑, 修复 remote 工作区 BYOK)
    patchAgentHostGate(staged, info);
    patchRuntimeCompat(staged, info);
    writeInstallationManifest(staged, [...applicationFiles(staged), ...treeFiles(staged.cursor2plusDir)]);
  }, { log: info, validatePrepared: verifyPreparedInstallation });

  console.log('');
  ok('Installation complete!');
  warn('Restart Cursor for changes to take effect.');
  info('Uninstall: node dist/cli.cjs uninstall');
}
