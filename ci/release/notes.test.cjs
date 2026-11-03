const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {checkPullRequest, notesSince} = require('./notes.cjs');

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deviceyard-notes-test-'));
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Notes Test'); git('config', 'user.email', 'test@example.invalid');
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true}); fs.writeFileSync(path.join(root, file), text); };
  const commit = (message) => { git('add', '-A'); git('commit', '-m', message); };
  write('README.md', 'base\n'); commit('Initial');
  // A feature branch merged with a merge commit, optionally adding a fragment.
  const merge = (name, fragment, text) => {
    git('switch', '-c', name);
    write('change-' + name + '.txt', name);
    if (fragment) write('release-notes/' + fragment + '.md', text);
    commit('Work on ' + name);
    git('switch', 'main'); git('merge', '--no-ff', name, '-m', 'Merge ' + name);
  };
  return {root, git, write, commit, merge, cleanup: () => fs.rmSync(root, {recursive: true, force: true})};
}

function withBranch(r, fragmentText) {
  r.git('switch', '-c', 'feature');
  r.write('src.txt', 'x');
  if (fragmentText !== undefined) r.write('release-notes/x.md', fragmentText);
  r.commit('Feature');
}

test('checkPullRequest accepts a branch that adds release-notes/x.md', () => {
  const r = makeRepo();
  try { withBranch(r, 'Adds a thing.\n'); assert.doesNotThrow(() => checkPullRequest(r.root, 'main', 'HEAD')); } finally { r.cleanup(); }
});

test('checkPullRequest rejects a branch without a new fragment', () => {
  const r = makeRepo();
  try {
    withBranch(r);
    assert.throws(() => checkPullRequest(r.root, 'main', 'HEAD'), /Add a release note: release-notes\/<slug>\.md \(1-5 lines, or "none"\)/);
  } finally { r.cleanup(); }
});

test('checkPullRequest rejects an empty fragment and one with more than five lines', () => {
  for (const text of ['\n  \n', 'a\nb\nc\nd\ne\nf\n']) {
    const r = makeRepo();
    try { withBranch(r, text); assert.throws(() => checkPullRequest(r.root, 'main', 'HEAD'), /Add a release note/); } finally { r.cleanup(); }
  }
});

test('checkPullRequest accepts a fragment containing only none', () => {
  const r = makeRepo();
  try { withBranch(r, 'none\n'); assert.doesNotThrow(() => checkPullRequest(r.root, 'main', 'HEAD')); } finally { r.cleanup(); }
});

test('collects fragments added since the previous tag across several merges', () => {
  const r = makeRepo();
  try {
    r.merge('old', 'old-change', 'Before the tag.\n');
    r.git('tag', 'v1.0.0');
    r.merge('one', 'first', 'First change.\n');
    r.merge('two', 'second', 'Second change.\nMore detail.\n');
    assert.equal(notesSince(r.root, 'v1.0.0'), '- First change.\n- Second change.\n- More detail.\n');
  } finally { r.cleanup(); }
});

test('drops none fragments and falls back to the maintenance text', () => {
  const r = makeRepo();
  try {
    r.git('tag', 'v1.0.0');
    r.merge('one', 'quiet', 'none\n');
    assert.equal(notesSince(r.root, 'v1.0.0'), 'Maintenance release without user-facing changes.\n');
    r.merge('two', 'loud', 'Visible.\n');
    assert.equal(notesSince(r.root, 'v1.0.0'), '- Visible.\n');
  } finally { r.cleanup(); }
});

test('first release (no previous tag) uses every fragment', () => {
  const r = makeRepo();
  try {
    r.merge('one', 'first', 'First change.\n');
    r.merge('two', 'second', 'Second change.\n');
    assert.equal(notesSince(r.root, null), '- First change.\n- Second change.\n');
  } finally { r.cleanup(); }
});
