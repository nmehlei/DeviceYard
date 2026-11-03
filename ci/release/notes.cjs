// Release-note fragments: one release-notes/<slug>.md per PR (1-5 lines, or the single line "none").
// The repository root is passed in (the CLI uses process.cwd()), so a checkout of this
// directory inside another repository (Pro's core/) works against that repository.
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');

const MAINTENANCE = 'Maintenance release without user-facing changes.';
const MISSING = 'Add a release note: release-notes/<slug>.md (1-5 lines, or "none")';
const FRAGMENT = /^release-notes\/[^/]+\.md$/;

function git(root, args) {
  return execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024});
}

function isFragmentPath(file) {
  return FRAGMENT.test(file) && file !== 'release-notes/README.md';
}

// Returns the fragment's lines, [] for "none", or null when the fragment is invalid.
function parseFragment(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 5) return null;
  if (lines.length === 1 && lines[0].toLowerCase() === 'none') return [];
  if (lines.some((line) => line.toLowerCase() === 'none')) return null;
  return lines;
}

function showAt(root, rev, file) {
  try { return git(root, ['show', `${rev}:${file}`]); } catch { return null; }
}

// Fragment text comes from contributors (including fork PRs) but is published under the
// maintainer's name: no HTML, no live @mentions, no leading Markdown syntax, bounded length.
function neutralize(line) {
  return line.slice(0, 200)
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@(?=\w)/g, '@\u200d')
    .replace(/^([#\-*+])/, '\\$1')
    .replace(/^(\d+)\./, '$1\\.');
}

function checkPullRequest(root, base, head) {
  try { git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]); } catch { throw new Error(`${base} not available`); }
  const added = git(root, ['diff', '-z', '--name-only', '--no-renames', '--diff-filter=A', `${base}...${head}`, '--', 'release-notes/'])
    .split('\0').filter(isFragmentPath);
  const valid = added.some((file) => {
    const text = showAt(root, head, file);
    return text !== null && parseFragment(text) !== null;
  });
  if (!valid) throw new Error(MISSING);
}

// Fragments are read as first added (later edits are ignored) and only if still present at head.
function notesSince(root, previousTag, head = 'HEAD') {
  const range = previousTag ? [`${previousTag}..${head}`] : [head];
  const log = git(root, ['log', '-z', '--reverse', '--no-merges', '--no-renames', '--diff-filter=A', '--name-only', '--format=%x01%H%x02', ...range, '--', 'release-notes/']);
  const present = new Set(git(root, ['ls-tree', '-r', '-z', '--name-only', head, '--', 'release-notes/']).split('\0'));
  const seen = new Set();
  const bullets = [];
  let commit = null;
  for (let token of log.split('\0')) {
    const m = /\x01([0-9a-f]+)\x02/.exec(token);
    if (m) { commit = m[1]; token = token.slice(m.index + m[0].length); }
    token = token.replace(/^\n+/, '');
    if (!token || !isFragmentPath(token) || seen.has(token) || !present.has(token)) continue;
    seen.add(token);
    const text = showAt(root, commit, token);
    const lines = text === null ? null : parseFragment(text);
    if (lines) bullets.push(...lines.map((entry) => `- ${neutralize(entry)}`));
  }
  return bullets.length ? `${bullets.join('\n')}\n` : `${MAINTENANCE}\n`;
}

function main(argv) {
  const [command, a, b] = argv;
  const root = process.cwd();
  if (command === 'check' && a && b) {
    checkPullRequest(root, a, b);
    console.log('Release note fragment found.');
  } else if (command === 'since' && a && b) {
    fs.writeFileSync(b, notesSince(root, a === '-' ? null : a));
    console.log(`Wrote release notes to ${b}`);
  } else {
    throw new Error('Usage: notes.cjs check <base> <head> | notes.cjs since <tag|-> <outfile>');
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(1); }
}

module.exports = {checkPullRequest, notesSince, parseFragment};
