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

function checkPullRequest(root, base, head) {
  const added = git(root, ['diff', '--name-only', '--diff-filter=A', `${base}...${head}`, '--', 'release-notes/'])
    .split('\n').filter(isFragmentPath);
  const valid = added.some((file) => {
    const text = showAt(root, head, file);
    return text !== null && parseFragment(text) !== null;
  });
  if (!valid) throw new Error(MISSING);
}

function notesSince(root, previousTag, head = 'HEAD') {
  const range = previousTag ? [`${previousTag}..${head}`] : [head];
  const log = git(root, ['log', '--reverse', '--no-merges', '--diff-filter=A', '--name-only', '--format=commit %H', ...range, '--', 'release-notes/']);
  const present = previousTag ? null : new Set(git(root, ['ls-tree', '-r', '--name-only', head, '--', 'release-notes/']).split('\n'));
  const seen = new Set();
  const bullets = [];
  let commit = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('commit ')) { commit = line.slice(7); continue; }
    if (!line || !isFragmentPath(line) || seen.has(line)) continue;
    if (present && !present.has(line)) continue;
    seen.add(line);
    const text = showAt(root, present ? head : commit, line) ?? showAt(root, commit, line);
    const lines = text === null ? null : parseFragment(text);
    if (lines) bullets.push(...lines.map((entry) => (entry.startsWith('- ') ? entry : `- ${entry}`)));
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
