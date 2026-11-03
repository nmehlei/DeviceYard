const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
// Isolate git from the developer's or agent's configuration and inherited GIT_* variables.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const {checkPullRequest, notesSince} = require('./notes.cjs');

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deviceyard-notes-test-'));
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env}).trim();
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

test('neutralizes html, mentions and leading markdown in fragments', () => {
  const r = makeRepo();
  try {
    r.git('tag', 'v1.0.0');
    r.merge('one', 'evil', '# Heading\n<script>alert(1)</script> thanks @maintainer\n- item\n1. numbered\n> quote\n');
    r.merge('two', 'long', 'x'.repeat(300) + '\n');
    const out = notesSince(r.root, 'v1.0.0');
    const lines = out.trimEnd().split('\n');
    assert.equal(lines[0], '- \\# Heading');
    assert.equal(lines[1], '- &lt;script&gt;alert(1)&lt;/script&gt; thanks @\u200dmaintainer');
    assert.equal(lines[2], '- \\- item');
    assert.equal(lines[3], '- 1\\. numbered');
    assert.equal(lines[4], '- &gt; quote');
    assert.equal(lines[5], '- ' + 'x'.repeat(200));
    assert.ok(!out.includes('<'));
    assert.ok(!/@(?!\u200d)\w/.test(out));
  } finally { r.cleanup(); }
});

test('a fragment identical to a removed one still counts as added', () => {
  const r = makeRepo();
  try {
    r.write('release-notes/old.md', 'Same text.\n'); r.commit('Add old');
    r.git('switch', '-c', 'feature');
    r.git('rm', '-q', 'release-notes/old.md');
    r.write('release-notes/new.md', 'Same text.\n'); r.commit('Replace');
    assert.doesNotThrow(() => checkPullRequest(r.root, 'main', 'HEAD'));
  } finally { r.cleanup(); }
});

test('checkPullRequest fails clearly when the base ref is missing', () => {
  const r = makeRepo();
  try { assert.throws(() => checkPullRequest(r.root, 'origin/main', 'HEAD'), /origin\/main not available/); } finally { r.cleanup(); }
});

test('a fragment added after the tag and deleted before release is not published', () => {
  for (const tag of ['v1.0.0', null]) {
    const r = makeRepo();
    try {
      if (tag) r.git('tag', tag);
      r.merge('one', 'gone', 'Short lived.\n');
      r.merge('two', 'kept', 'Kept.\n');
      r.git('rm', '-q', 'release-notes/gone.md'); r.commit('Drop fragment');
      assert.equal(notesSince(r.root, tag), '- Kept.\n');
    } finally { r.cleanup(); }
  }
});

test('edits after merge are ignored', () => {
  for (const tag of ['v1.0.0', null]) {
    const r = makeRepo();
    try {
      if (tag) r.git('tag', tag);
      r.merge('one', 'a', 'Original.\n');
      r.write('release-notes/a.md', 'Edited later.\n'); r.commit('Edit');
      assert.equal(notesSince(r.root, tag), '- Original.\n');
    } finally { r.cleanup(); }
  }
});

test('fast-forward and squash merges are collected', () => {
  const r = makeRepo();
  try {
    r.git('tag', 'v1.0.0');
    r.git('switch', '-c', 'ff'); r.write('release-notes/ff.md', 'Fast forward.\n'); r.commit('ff');
    r.git('switch', 'main'); r.git('merge', '--ff-only', 'ff');
    r.git('switch', '-c', 'sq'); r.write('release-notes/sq.md', 'Squashed.\n'); r.commit('sq');
    r.git('switch', 'main'); r.git('merge', '--squash', 'sq'); r.commit('Squash sq');
    assert.equal(notesSince(r.root, 'v1.0.0'), '- Fast forward.\n- Squashed.\n');
  } finally { r.cleanup(); }
});

test('CLI since writes the notes file and check reports failures', () => {
  const r = makeRepo();
  try {
    r.merge('one', 'first', 'First change.\n');
    const out = path.join(r.root, '..', path.basename(r.root) + '-notes.md');
    const script = path.join(__dirname, 'notes.cjs');
    execFileSync('node', [script, 'since', '-', out], {cwd: r.root, env: process.env, stdio: 'pipe'});
    assert.equal(fs.readFileSync(out, 'utf8'), '- First change.\n');
    fs.rmSync(out);
    assert.throws(() => execFileSync('node', [script, 'check', 'main', 'HEAD'], {cwd: r.root, env: process.env, stdio: 'pipe'}));
  } finally { r.cleanup(); }
});
