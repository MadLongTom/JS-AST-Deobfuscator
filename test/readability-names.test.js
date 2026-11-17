'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('@babel/parser');
const { deobfuscate } = require('../src');
const { assertPreserved } = require('./helpers');
const { indexWebpackModules, webpackModuleExcerpts } = require('../src/readability/webpack');
const options = { passes: [], profile: 'readable', renameBindings: true };

const bundle = `(function (_0xa1) {
  var _0xa2 = {};
  function _0xa3(_0xa4) {
    if (_0xa2[_0xa4]) return _0xa2[_0xa4].exports;
    var _0xa5 = _0xa2[_0xa4] = {exports: {}};
    _0xa1[_0xa4].call(_0xa5.exports, _0xa5, _0xa5.exports, _0xa3);
    return _0xa5.exports;
  }
  globalThis.result = _0xa3(0);
})([function (_0xb1, _0xb2, _0xb3) { _0xb1.exports = _0xb3(1) + 1; }, function (_0xc1) { _0xc1.exports = 2; }]);`;

test('naming follows verified webpack invocation roles and indexes dependencies', () => {
  const result = assertPreserved(bundle, options);
  assert.equal(result.report.readability.webpackFactories, 2);
  assert.match(result.code, /function \(module, exports, require\)/);
  assert.match(result.code, /module\.exports = require\(1\) \+ 1/);
  const ast = parser.parse(result.code);
  const index = indexWebpackModules(ast);
  assert.equal(index.length, 1);
  assert.deepEqual(index[0].entryIds, [0]);
  assert.deepEqual(index[0].modules[0].dependencies, [1]);
  assert.equal(webpackModuleExcerpts(ast).length, 2);
});

test('an arbitrary array of three-parameter functions is not a webpack bundle', () => {
  const { code, report } = assertPreserved('(function () { var _0x1234 = [function (_0xabcd, _0xbcde, _0xcdef) { return _0xabcd; }]; globalThis.result = _0x1234[0](4); })();', options);
  assert.equal(report.readability.webpackFactories, 0);
  assert.doesNotMatch(code, /function \(module, exports, require\)/);
});

test('renaming avoids collisions, nested captures and shorthand key changes', () => {
  for (const source of [
    '(function (_0xabcd) { var arg1 = 9; globalThis.result = [_0xabcd, arg1]; })(3);',
    '(function (_0xabcd) { function inner(arg1) { return [_0xabcd, arg1]; } globalThis.result = inner(9); })(3);',
    '(function (_0xabcd) { globalThis.result = [_0xabcd, typeof arg1]; })(3);',
    '(function (_0xabcd) { globalThis.result = {_0xabcd}; })(3);',
    '(function () { var {x: _0xabcd} = {x: 3}; globalThis.result = _0xabcd; })();',
  ]) assertPreserved(source, options);
});

test('function and class explicit/inferred names remain observable through escapes', () => {
  for (const body of [
    'function _0xabcd() {} var names = [ _0xabcd ].map(function (f) { return f.name; }); globalThis.result = names;',
    'var _0xabcd = function () {}; globalThis.result = _0xabcd.name;',
    'var _0xabcd = () => 1; globalThis.result = [_0xabcd][0].name;',
    'class _0xabcd {} globalThis.result = new _0xabcd().constructor.name;',
    'var _0xabcd; _0xabcd = function () {}; globalThis.result = _0xabcd.name;',
    'var {x: _0xabcd = function () {}} = {}; globalThis.result = _0xabcd.name;',
  ]) assertPreserved(`(function () { ${body} })();`, options);
});

test('dynamic eval keeps visible names while unrelated sibling bindings can be renamed', () => {
  const result = assertPreserved(`(function () {
    function unsafe(_0xabcd) { return eval('_0xabcd'); }
    function safe(_0xbcde) { return _0xbcde + 1; }
    globalThis.result = [unsafe(3), safe(4)];
  })();`, options);
  assert.match(result.code, /function unsafe\(_0xabcd\)/);
  assert.doesNotMatch(result.code, /_0xbcde/);
});

test('public script bindings and exports keep their external names', () => {
  const script = deobfuscate('var _0xabcd = 3; globalThis.result = _0xabcd;', options);
  assert.match(script.code, /var _0xabcd/);
  const module = deobfuscate('export const _0xabcd = 3;', { ...options, sourceType: 'module' });
  assert.match(module.code, /export const _0xabcd/);
});
