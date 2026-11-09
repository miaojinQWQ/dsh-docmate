// Pre-publish gate for dsh-docmate.
//
//   node scripts/prepublish.mjs
//
// Two things must be true before this package can go to npm, and both are easy to forget:
//
//   1. `package.json` still carries `CHANGE-ME` placeholders where the public repository URL
//      belongs. Publishing with them ships metadata that points at a repository that does not
//      exist — the market card then links nowhere.
//   2. `client.js` must be the current build of `src/client/**`. npm publishes whatever is on
//      disk, so a stale bundle means everyone installs an old panel.
//
// Exits non-zero with a readable message instead of publishing something broken.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const fields = [
  ['homepage', manifest.homepage],
  ['repository.url', manifest.repository && manifest.repository.url],
  ['bugs.url', manifest.bugs && manifest.bugs.url],
];

const placeholders = fields.filter(([, value]) => typeof value === 'string' && value.includes('CHANGE-ME'));

if (placeholders.length > 0) {
  console.error('');
  console.error('  ✗ package.json 里还有 CHANGE-ME 占位，先换成真实仓库地址再发布：');
  for (const [name] of placeholders) console.error('      - ' + name);
  console.error('');
  process.exit(1);
}

try {
  execFileSync(process.execPath, [path.join(root, 'build.mjs'), '--check'], { stdio: 'inherit' });
} catch (error) {
  console.error('');
  console.error('  ✗ client.js 构建失败，先修好再发布');
  console.error('');
  process.exit(1);
}

console.log('');
console.log('  ✓ 发布前检查通过');
console.log('');
