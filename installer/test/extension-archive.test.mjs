import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { installExtensionArchive } from '../src/extension-archive.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ccursor-vsix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'cursor2plus');
  mkdirSync(target);
  writeFileSync(join(target, 'known-good.txt'), 'working extension');
  return { root, target, archive: join(root, 'new.vsix') };
}

function writeArchive(path, extra = {}) {
  writeFileSync(path, zipSync({
    'extension/package.json': strToU8(JSON.stringify({ name: 'cursor2plus', main: './dist/extension.js' })),
    'extension/dist/extension.js': strToU8('module.exports = { newBuild: true };'),
    ...extra,
  }));
}

test('missing, corrupt and incomplete VSIX preserve the working extension', (t) => {
  const { target, archive } = fixture(t);
  for (const prepare of [
    () => {},
    () => writeFileSync(archive, 'not a zip'),
    () => writeFileSync(archive, zipSync({ 'extension/other.txt': strToU8('x') })),
    () => writeFileSync(archive, zipSync({
      'extension/package.json': strToU8('{"name":"cursor2plus","main":"./dist/extension.js"}'),
    })),
    () => writeArchive(archive, { 'extension/package.json': strToU8('{') }),
    () => writeArchive(archive, { 'extension/package.json': strToU8('{"name":"other"}') }),
  ]) {
    prepare();
    assert.throws(() => installExtensionArchive(target, archive));
    assert.equal(readFileSync(join(target, 'known-good.txt'), 'utf8'), 'working extension');
  }
});

test('failure while writing the staged extension keeps old files and cleans up', (t) => {
  const { root, target, archive } = fixture(t);
  writeFileSync(archive, zipSync({
    'extension/package.json': strToU8('{"name":"cursor2plus","main":"./dist/extension.js"}'),
    'extension/dist': strToU8('a file conflicts with the directory'),
    'extension/dist/extension.js': strToU8('new build'),
  }));
  assert.throws(() => installExtensionArchive(target, archive));
  assert.equal(readFileSync(join(target, 'known-good.txt'), 'utf8'), 'working extension');
  assert.deepEqual(readdirSync(root).sort(), ['cursor2plus', 'new.vsix']);
});

test('rejects path traversal and Windows escape paths before modifying the target', (t) => {
  const { root, target, archive } = fixture(t);
  for (const entry of ['../escaped.txt', '/escaped.txt', 'C:/escaped.txt', '..\\escaped.txt', 'dist/../../escaped.txt']) {
    writeArchive(archive, { [`extension/${entry}`]: strToU8('bad') });
    assert.throws(() => installExtensionArchive(target, archive), /Unsafe VSIX entry/);
    assert.equal(readFileSync(join(target, 'known-good.txt'), 'utf8'), 'working extension');
    assert.equal(existsSync(join(root, 'escaped.txt')), false);
  }
});

test('fully prepared extension replaces old files and removes its staging directory', (t) => {
  const { root, target, archive } = fixture(t);
  writeArchive(archive);
  assert.equal(installExtensionArchive(target, archive), 2);
  assert.equal(existsSync(join(target, 'known-good.txt')), false);
  assert.equal(readFileSync(join(target, 'dist/extension.js'), 'utf8'), 'module.exports = { newBuild: true };');
  assert.deepEqual(readdirSync(root).sort(), ['cursor2plus', 'new.vsix']);
  assert.equal(installExtensionArchive(target, archive), 2, 'repeating an install remains valid');
});
