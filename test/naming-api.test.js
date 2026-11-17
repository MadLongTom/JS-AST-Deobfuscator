'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { deobfuscate } = require('../src');

test('binding naming is an explicit readable final stage with mapping metadata', () => {
  const source = '(function (_0xabcd) { var _0x1234 = _0xabcd.value; globalThis.result = _0x1234; })({value: 3});';
  const original = deobfuscate(source, { passes: [], profile: 'readable' });
  const renamed = deobfuscate(source, { passes: [], profile: 'readable', renameBindings: true });
  assert.match(original.code, /_0xabcd/);
  assert.doesNotMatch(renamed.code, /_0xabcd|_0x1234/);
  assert.ok(renamed.report.readability.changes >= 2);
  assert.equal(renamed.report.totals.readabilityChanges, renamed.report.readability.changes);
  assert.ok(Array.isArray(renamed.report.readability.renamed));
});

test('naming options reject unsafe profiles and invalid types', () => {
  assert.throws(() => deobfuscate('1;', { renameBindings: true }), error => error.code === 'INVALID_OPTIONS');
  assert.throws(() => deobfuscate('1;', { profile: 'readable', renameBindings: 'yes' }), error => error.code === 'INVALID_OPTIONS');
});

test('CLI --rename reaches the final naming stage and requires readable', () => {
  const input = '(function (_0x1234) { globalThis.result = _0x1234; })(3);';
  const success = spawnSync(process.execPath, ['bin/js-ast-deobfuscator.js', '-', '--profile', 'readable', '--rename'], { input, encoding: 'utf8', windowsHide: true });
  assert.equal(success.status, 0, success.stderr);
  assert.doesNotMatch(success.stdout, /_0x1234/);
  const failure = spawnSync(process.execPath, ['bin/js-ast-deobfuscator.js', '-', '--rename'], { input, encoding: 'utf8', windowsHide: true });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /requires the readable profile/);
});
