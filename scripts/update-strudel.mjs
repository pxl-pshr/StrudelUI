// Update the vendored Strudel engine (@strudel/repl from npm) in vendor/strudel-repl.
//
//   npm run update-strudel            newest release
//   npm run update-strudel 1.4.0      a given version
//   npm run update-strudel -- --check only report: installed vs newest
//
// Then run `npm test` and `npm run smoke` before committing.
// In GitHub Actions it also writes current/latest/updated to $GITHUB_OUTPUT.

import { execFileSync } from 'node:child_process';
import { readFile, writeFile, readdir, rm, cp, mkdtemp, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENDOR = join(ROOT, 'vendor/strudel-repl');
const PKG = '@strudel/repl';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const wanted = args.find((a) => !a.startsWith('--')) ?? 'latest';

const npm = (...a) => execFileSync('npm', a, { encoding: 'utf8' }).trim();
const current = (await readFile(join(VENDOR, 'VERSION'), 'utf8').catch(() => 'unknown')).trim();
const target = wanted === 'latest' ? npm('view', PKG, 'version') : npm('view', `${PKG}@${wanted}`, 'version');

const output = async (values) => {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
};

console.log(`installed ${PKG} ${current}, ${wanted === 'latest' ? 'newest' : 'asked for'} ${target}`);
if (checkOnly || target === current) {
  if (target === current) console.log('nothing to update');
  await output({ current, latest: target, updated: false });
  process.exit(0);
}

// download the package and swap in its build: the ES module entry, its
// chunks and assets, and the license. The single-file UMD build (index.js)
// isn't used by the app.
const tmp = await mkdtemp(join(tmpdir(), 'strudel-update-'));
try {
  const tgz = npm('pack', `${PKG}@${target}`, '--pack-destination', tmp, '--silent').split('\n').pop();
  execFileSync('tar', ['xzf', join(tmp, tgz), '-C', tmp]);
  const dist = join(tmp, 'package/dist');
  const files = (await readdir(dist)).filter((f) => f !== 'index.js');
  if (!files.includes('index.mjs')) throw new Error(`${PKG}@${target} has no dist/index.mjs: the layout changed, update by hand`);

  await rm(VENDOR, { recursive: true, force: true });
  for (const f of files) await cp(join(dist, f), join(VENDOR, f), { recursive: true });
  await cp(join(tmp, 'package/LICENSE'), join(VENDOR, 'LICENSE'));
  await writeFile(join(VENDOR, 'VERSION'), `${target}\n`);

  // the README names the version
  const readmePath = join(ROOT, 'README.md');
  const readme = await readFile(readmePath, 'utf8');
  await writeFile(readmePath, readme.replace(/(\[@strudel\/repl\]\([^)]*\) )\d+\.\d+\.\d+/, `$1${target}`));

  console.log(`updated vendor/strudel-repl to ${target} (${files.length} files)`);
  console.log('next: npm test && npm run smoke');
  await output({ current, latest: target, updated: true });
} finally {
  await rm(tmp, { recursive: true, force: true });
}
