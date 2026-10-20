/**
 * Install 时释放默认资源到 ~/.ccursor/
 *
 * 释放内容:
 *   - routes.json         ← DEFAULT_ROUTES (keep-if-exists:保留用户路由与 BYOK 偏好)
 *   - providers.json      ← DEFAULT_PROVIDERS (keep-if-exists:用户 API Key 不能丢)
 *   - models-catalog.json ← 从 installer 自带的 assets 复制 (models.dev 快照,强制覆盖)
 *
 * 已有 routes.json 原样保留;运行时 routesStore 负责合并默认值。
 * 安装或升级不能重置用户的 byokMode / host / port / redirect。
 *
 * 首次创建 routes.json 时自动检测 byokMode:
 *   读取 Cursor 的 state.vscdb, 如果 cursorAuth/accessToken 不存在或 onboarding
 *   未完成 → byokMode: 0 (OFF), 允许用户先完成登录/引导再手动开启 BYOK。
 *   已登录且引导完成 → byokMode: 1 (ON), 直接进入 BYOK 模式。
 */
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import {
  MODELS_CATALOG_FILE_NAME,
  PROVIDERS_FILE_NAME,
  ROUTES_FILE_NAME,
  WEB_TOOLS_FILE_NAME,
  DEFAULT_PROVIDERS,
  DEFAULT_ROUTES,
  DEFAULT_WEB_TOOLS,
  BASE_REDIRECT,
  DEFAULT_REDIRECT,
} from './defaults.js';
import { CCURSOR_DIR } from './routes.js';

function getCursorStateDbPath() {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'win32':
      return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'linux':
      return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    default:
      return join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
}

function detectByokMode(log) {
  const vscdb = getCursorStateDbPath();
  if (!existsSync(vscdb)) {
    log?.('  [detect] state.vscdb not found → byokMode: 0 (fresh Cursor)');
    return 0;
  }
  try {
    const query = "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken' LIMIT 1";
    const token = execFileSync('sqlite3', [vscdb, query], { encoding: 'utf-8', timeout: 5000 }).trim();
    if (!token || token.length < 10) {
      log?.('  [detect] no accessToken → byokMode: 0 (not logged in)');
      return 0;
    }
    const query2 = "SELECT value FROM ItemTable WHERE key='workbench.contrib.onboarding.browser.gettingStarted.contribution.ts.firsttime' LIMIT 1";
    const firsttime = execFileSync('sqlite3', [vscdb, query2], { encoding: 'utf-8', timeout: 5000 }).trim();
    if (firsttime === '' || firsttime === 'true') {
      log?.('  [detect] onboarding not completed → byokMode: 0');
      return 0;
    }
    log?.('  [detect] logged in + onboarding done → byokMode: 1');
    return 1;
  } catch (e) {
    log?.(`  [detect] sqlite3 failed: ${e.message} → byokMode: 1 (fallback)`);
    return 1;
  }
}

function release(configDir, filename, content, log, { force = false } = {}) {
  const dest = join(configDir, filename);
  if (!force && existsSync(dest)) {
    log?.(`  ${filename} already exists, keep`);
    return false;
  }
  const existed = existsSync(dest);
  writeFileSync(dest, JSON.stringify(content, null, 2) + '\n', 'utf-8');
  log?.(`  ${filename} ${existed ? 'overwritten' : 'released'}`);
  return true;
}

// 打包后 __dirname 指向 cli.cjs 所在目录 (installer/dist/),
// 与之同级存放 models-catalog.json (esbuild.js 构建时复制)。
// 开发模式从 src/ 直接跑时 fallback 到 src/../assets/
function resolveAssetPath(filename) {
  const candidates = [
    join(__dirname, filename),                  // bundled: dist/<file>
    join(__dirname, '..', 'assets', filename),  // dev: src/../assets/<file>
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function copyAsset(configDir, filename, log, { force = false } = {}) {
  const dest = join(configDir, filename);
  if (!force && existsSync(dest)) {
    log?.(`  ${filename} already exists, keep`);
    return false;
  }
  const src = resolveAssetPath(filename);
  if (!src) {
    log?.(`  ${filename} asset not bundled, skip`);
    return false;
  }
  const existed = existsSync(dest);
  copyFileSync(src, dest);
  const size = (readFileSync(dest).length / 1024).toFixed(1);
  log?.(`  ${filename} ${existed ? 'updated' : 'released'} (${size} KB)`);
  return true;
}

export function releaseDefaults(log, { configDir = CCURSOR_DIR } = {}) {
  log?.(`[defaults] Releasing to ${configDir}...`);
  mkdirSync(configDir, { recursive: true });

  if (existsSync(join(configDir, ROUTES_FILE_NAME))) {
    log?.(`  ${ROUTES_FILE_NAME} already exists, keep`);
  } else {
    const mode = detectByokMode(log);
    const routes = {
      ...DEFAULT_ROUTES,
      byokMode: mode,
      redirect: mode ? [...DEFAULT_REDIRECT] : [...BASE_REDIRECT],
    };
    release(configDir, ROUTES_FILE_NAME, routes, log);
  }
  release(configDir, PROVIDERS_FILE_NAME, DEFAULT_PROVIDERS, log);
  release(configDir, WEB_TOOLS_FILE_NAME, DEFAULT_WEB_TOOLS, log);
  copyAsset(configDir, MODELS_CATALOG_FILE_NAME, log, { force: true });

  log?.('[defaults] Done');
}
