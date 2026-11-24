const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const STUB = "exports.loadConfig = (env) => { if (env.BAD === 'secret-value') throw Error('bad: secret-value'); };\n";

// Lays out an image's /opt/deviceyard with the validator and the given files ({path: contents}).
function run(files, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-config-'));
  try {
    fs.mkdirSync(path.join(root, 'container'));
    fs.copyFileSync(path.join(__dirname, 'validate-config.cjs'), path.join(root, 'container', 'validate-config.cjs'));
    for (const [file, contents] of Object.entries(typeof files === 'string' ? {[files]: STUB} : files ?? {})) {
      fs.mkdirSync(path.join(root, path.dirname(file)), {recursive: true});
      fs.writeFileSync(path.join(root, file), contents);
    }
    return spawnSync(process.execPath, [path.join(root, 'container', 'validate-config.cjs')],
      {env: {PATH: process.env.PATH, ...env}, encoding: 'utf8'});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

test('Community layout: config module under dist/src', () => {
  assert.equal(run('dist/src/config.js').status, 0);
});

test('Pro layout: config module under dist/core/src', () => {
  assert.equal(run('dist/core/src/config.js').status, 0);
});

test('invalid configuration fails without echoing the parser error', () => {
  const result = run('dist/core/src/config.js', {BAD: 'secret-value'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid DeviceYard configuration/);
  assert.doesNotMatch(result.stderr, /secret-value/);
});

test('the core config under dist/core wins over a Pro module named dist/src/config.js', () => {
  const result = run({'dist/core/src/config.js': STUB, 'dist/src/config.js': "throw Error('not the core config');\n"},
    {BAD: 'secret-value'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid DeviceYard configuration/);
});

for (const [name, files] of [['no config module', null],
  ['a module without loadConfig', {'dist/src/config.js': 'exports.other = 1;\n'}],
  ['a module that fails to load', {'dist/src/config.js': "require('missing-dependency');\n"}]]) {
  test(`an image with ${name} is reported as incomplete, not as a configuration error`, () => {
    const result = run(files);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no usable DeviceYard config module/);
    assert.doesNotMatch(result.stderr, /Invalid DeviceYard configuration/);
  });
}
