const {test} = require('node:test');
const assert = require('node:assert/strict');
const {nativeVersion} = require('./version.cjs');
const version = '1.2.3';

test('ordinary builds use the shared GitVersion result', () => {
  for (const reason of ['Manual','IndividualCI','PullRequest']) {
    assert.equal(nativeVersion({mode:'candidate',version:'1.2.3',buildId:'123',reason}), '1.2.3-ci.123');
  }
});
test('stable packaging uses the shared version only on manual main builds', () => {
  assert.equal(nativeVersion({mode:'stable',version:'1.2.3',reason:'Manual',branch:'refs/heads/main'}),'1.2.3');
  for (const reason of ['PullRequest','IndividualCI','Schedule']) {
    assert.throws(()=>nativeVersion({mode:'stable',version,reason,branch:'refs/heads/main'}));
  }
  assert.throws(()=>nativeVersion({mode:'stable',version,reason:'Manual',branch:'refs/heads/feature'}));
});
test('rejects invalid version, mode and pipeline command injection', () => {
  for (const invalid of ['', 'v1.0.0','01.0.0','1.0.0-rc.1','1.0.0\n##vso[task.setvariable variable=x]y']) {
    assert.throws(()=>nativeVersion({mode:'candidate',version:invalid,buildId:'123'}));
  }
  for (const buildId of ['', 'abc','1\n2']) assert.throws(()=>nativeVersion({mode:'candidate',version,buildId}));
  assert.throws(()=>nativeVersion({mode:'1.0.0',version,reason:'Manual',branch:'refs/heads/main'}));
});
