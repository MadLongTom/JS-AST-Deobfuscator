'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertPreserved } = require('./helpers');
const { deobfuscate } = require('../src');
const options = { passes: ['inline-aliases'] };

test('private immutable function and object aliases are inlined and removed', () => {
  const { code } = assertPreserved(`(function () {
    function source(x) { return x + 1; }
    var object = {value: 2}; var alias = source; var other = object;
    globalThis.result = [alias(2), other.value, alias.name];
  })();`, options);
  assert.doesNotMatch(code, /\balias\b|\bother\b/);
});

test('aliases retain capture boundaries, initialization and live source changes', () => {
  for (const body of [
    `var source = 1; var alias = source; function read(source) { return alias; } globalThis.result = read(2);`,
    `var alias = source; var source = 1; globalThis.result = alias;`,
    `var source = 1; var alias = source; source = 2; globalThis.result = alias;`,
    `var source = 1; globalThis.result = read(); var alias = source; function read() { return alias; }`,
    `var source = 1; var alias = source; eval('alias = 3'); globalThis.result = alias;`,
    `var source = 1; var alias = source; with ({source: 9}) { globalThis.result = alias; }`,
  ]) assertPreserved(`(function () { ${body} })();`, options);
});

test('parameter aliases in private closures are resolved only after initialization', () => {
  const { code } = assertPreserved(`(function (source) { var alias = source; globalThis.result = function () { return alias; }(); })(3);`, options);
  assert.doesNotMatch(code, /\balias\b/);
});

test('aliases of eval keep the original indirect call semantics', () => {
  assertPreserved(`(function (eval) { var secret = 4; var alias = eval; globalThis.result = alias('typeof secret'); })(globalThis.eval);`, options);
});

test('script public aliases remain visible and object shorthand keeps its key', () => {
  const { code } = assertPreserved(`var source = 1; var alias = source; globalThis.result = {alias};`, options);
  assert.match(code, /var alias/);
  assertPreserved(`(function () { var source = 1; var alias = source; globalThis.result = {alias}; })();`, options);
});

test('a wrapper with multiple calls is fully expanded in one pass snapshot', () => {
  const { code, report } = assertPreserved(`(function () {
    function wrap(value) { return value == null; }
    globalThis.result = [wrap(1), wrap(2), wrap(3), wrap(null)];
  })();`, { passes: ['inline-wrappers'], maxIterations: 1 });
  assert.equal(report.passes[0].changes, 4);
  assert.doesNotMatch(code, /wrap\([123]|wrap\(null/);
});

test('a captured public script binding is not replaced by a live global read', () => {
  const { code } = assertPreserved(`function source() { return 1; }
    (function () { var alias = source; globalThis.source = function () { return 2; }; globalThis.result = alias(); })();`, options);
  assert.match(code, /var alias/);
});

test('an import alias remains a snapshot of an externally live binding', () => {
  const { code } = deobfuscate("import { source } from 'somewhere'; function read() { var alias = source; mutateExporter(); return alias; } export {read};", options);
  assert.match(code, /var alias/);
  assert.match(code, /return alias/);
});
