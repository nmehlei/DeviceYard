const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {assertPublishable} = require('./check-archive.cjs');

function runtime(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deviceyard-archive-test-'));
  const files = {'release.json': '{}', 'dist/index.js': '', 'notices/LICENSE': 'x', ...extra};
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

test('accepts a minimal community runtime', () => {
  assert.doesNotThrow(() => assertPublishable(runtime(), 'community'));
});

test('rejects a TypeScript source outside node_modules but allows node_modules d.ts', () => {
  assert.doesNotThrow(() => assertPublishable(runtime({'node_modules/pkg/index.d.ts': '', 'node_modules/pkg/index.ts': ''}), 'community'));
  assert.throws(() => assertPublishable(runtime({'dist/x.d.ts': ''}), 'community'), /x\.d\.ts/);
  assert.throws(() => assertPublishable(runtime({'dist/src/server.ts': ''}), 'community'), /dist[\\/]src[\\/]server\.ts/);
});

test('rejects docs/superpowers, .superpowers, tests and ci directories', () => {
  for (const file of ['docs/superpowers/spec.md', '.superpowers/x', 'tests/a.js', 'ci/build.cjs', 'src/a.js', 'dist/tests/x.js', 'dist/.superpowers/x', 'dist/docs/superpowers/x.md']) {
    assert.throws(() => assertPublishable(runtime({[file]: ''}), 'community'), /forbidden path/, file);
  }
  // A nested tests directory inside node_modules is third-party content and stays allowed.
  assert.doesNotThrow(() => assertPublishable(runtime({'node_modules/pkg/tests/a.js': '', 'node_modules/pkg/ci/b.js': '', 'node_modules/pkg/src/c.js': ''}), 'community'));
});

test('requires PRO-LICENSE for pro only', () => {
  assert.throws(() => assertPublishable(runtime(), 'pro'), /PRO-LICENSE/);
  assert.doesNotThrow(() => assertPublishable(runtime({'PRO-LICENSE': 'x'}), 'pro'));
  assert.doesNotThrow(() => assertPublishable(runtime(), 'community'));
  const dir = runtime(); fs.rmSync(path.join(dir, 'notices/LICENSE'));
  assert.throws(() => assertPublishable(dir, 'community'), /notices[\\/]LICENSE/);
});
