// tsc copies only what it compiles: the icon, the codex file and the vendored
// parser go into dist beside the node that loads them.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'nodes', 'Blurwerk');
const dst = join(root, 'dist', 'nodes', 'Blurwerk');
mkdirSync(join(dst, 'vendor'), { recursive: true });
for (const f of ['blurwerk.svg', 'Blurwerk.node.json']) copyFileSync(join(src, f), join(dst, f));
for (const f of readdirSync(join(src, 'vendor')).filter((n) => n.endsWith('.js'))) copyFileSync(join(src, 'vendor', f), join(dst, 'vendor', f));
