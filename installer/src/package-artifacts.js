import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '..', 'artifacts');
mkdirSync(output, { recursive: true });
const vsix = readdirSync(join(root, 'vsix')).filter(name => name.endsWith('.vsix'));
if (vsix.length !== 1) throw new Error('Build exactly one VSIX before packaging artifacts');
copyFileSync(join(root, 'vsix', vsix[0]), join(output, vsix[0]));
if (!process.env.npm_execpath) throw new Error('Run npm run package:artifacts');
const packed = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: root, encoding: 'utf8' }));
const names = [vsix[0], packed[0].filename];
const sums = names.map(name => `${createHash('sha256').update(readFileSync(join(output, name))).digest('hex')}  ${name}`).join('\n') + '\n';
writeFileSync(join(output, 'SHA256SUMS'), sums);
console.log(`Packaged ${names.join(', ')} with SHA256SUMS`);
