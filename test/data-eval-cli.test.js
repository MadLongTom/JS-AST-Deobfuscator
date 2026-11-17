'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const parser = require('@babel/parser');

const cli = path.join(__dirname, '../bin/js-ast-deobfuscator.js');
const source = 'function parseData(response) { return eval("(" + response.body + ")"); }';
const run = args => spawnSync(process.execPath, [cli, '-', ...args], {
  input: source, encoding: 'utf8', timeout: 30000, windowsHide: true,
});

test('CLI data-eval opt-in is accepted only with the explicit readable profile', () => {
  const rejected = run(['--assume-data-eval']);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /INVALID_OPTIONS.*requires the readable profile/);
  assert.equal(rejected.stdout, '');
  const accepted = run(['--profile', 'readable', '--assume-data-eval']);
  assert.equal(accepted.status, 0, accepted.stderr);
  parser.parse(accepted.stdout);
  assert.match(accepted.stdout, /eval\(/);
  assert.match(accepted.stderr, /ASSUMED_DATA_EVAL/);
});

test('CLI readable alone retains the default eval barrier without assumptions', () => {
  const result = run(['--profile', 'readable']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /eval\(/);
  assert.doesNotMatch(result.stderr, /ASSUMED_DATA_EVAL/);
});
