const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

// Directory names that must never ship in a public archive, at any depth outside node_modules.
const FORBIDDEN_DIRS = new Set(['tests', 'ci', '.superpowers']);
const REQUIRED = ['release.json', 'dist/index.js', 'notices/LICENSE'];

function offending(rel, isDir) {
  const parts = rel.split(path.sep);
  // Third-party content below any node_modules (e.g. dist/core/node_modules in Pro) is exempt:
  // it ships .ts sources, .d.ts and tests/ directories legitimately.
  if (parts.includes('node_modules')) return false;
  if (isDir && parts.length === 1 && parts[0] === 'src') return true; // Pro's src/ (dist/core/src is fine)
  if (isDir && FORBIDDEN_DIRS.has(parts[parts.length - 1])) return true;
  if (isDir && parts.length >= 2 && parts[parts.length - 2] === 'docs' && parts[parts.length - 1] === 'superpowers') return true;
  if (!isDir && /\.(ts|tsx|mts|cts)$/.test(rel)) return true;
  return false;
}

function walk(dir, root, found) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (offending(rel, entry.isDirectory())) { found.push(rel); return found; }
    if (entry.isDirectory()) { walk(full, root, found); if (found.length) return found; }
  }
  return found;
}

function assertPublishable(dir, edition) {
  if (edition !== 'community' && edition !== 'pro') throw Error(`Unknown edition: ${edition}`);
  const bad = walk(dir, dir, []);
  if (bad.length) throw Error(`Archive contains forbidden path: ${bad[0]}`);
  for (const file of [...REQUIRED, ...(edition === 'pro' ? ['PRO-LICENSE'] : [])]) {
    if (!fs.existsSync(path.join(dir, file))) throw Error(`Archive misses required file: ${path.normalize(file)}`);
  }
}

module.exports = {assertPublishable};

if (require.main === module) {
  const [archive, edition] = process.argv.slice(2);
  if (!archive || !edition) { console.error('Usage: check-archive.cjs <archive.tar.gz> <community|pro>'); process.exit(2); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deviceyard-archive-'));
  try {
    execFileSync('tar', ['-xzf', archive, '-C', dir], {stdio: 'inherit'});
    assertPublishable(dir, edition);
    console.log(`Archive is publishable (${edition})`);
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}
