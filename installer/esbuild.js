import { execFileSync } from 'child_process';
import esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let buildRevision = process.env.GITHUB_SHA || 'unknown';
if (buildRevision === 'unknown') {
  try {
    buildRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) buildRevision += '-dirty';
  } catch {}
}
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));

// 1. Bundle
await esbuild.build({
  entryPoints: ['src/cli.js'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/cli.cjs',
  minify: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['acorn'],
  define: {
    'process.env.CURSOR2PLUS_VERSION': JSON.stringify(pkg.version),
    'process.env.CCURSOR_BUILD_SHA': JSON.stringify(buildRevision),
  },
});

console.log('[build] dist/cli.cjs (%s KB)', (readFileSync('dist/cli.cjs').length / 1024).toFixed(1));

// 2. Copy assets (models catalog) as sibling files — avoids bloating cli.cjs bundle
mkdirSync('dist', { recursive: true });
const ASSETS = ['models-catalog.json'];
for (const asset of ASSETS) {
  const src = join(__dirname, 'assets', asset);
  const dest = join(__dirname, 'dist', asset);
  copyFileSync(src, dest);
  console.log('[build] copied asset → dist/%s (%s KB)', asset, (readFileSync(dest).length / 1024).toFixed(1));
}

console.log('[build] done');

for (const asset of ['punycode.cjs', 'punycode.LICENSE.txt']) {
  copyFileSync(join(__dirname, 'assets', 'vendor', asset), join(__dirname, 'dist', asset));
}

copyFileSync(join(__dirname, '..', 'LICENSE'), join(__dirname, 'dist', 'LICENSE'));
