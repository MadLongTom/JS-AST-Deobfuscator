'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deobfuscate } = require('../src/index.js');
const { assertPreserved } = require('./helpers.js');

const decoder = `
  function table() { var entries = ['hello', 'world']; return entries; }
  function decode(index) { var entries = table(); return entries[index - 16]; }
`;
const options = { passes: ['decode-string-arrays'] };

test('decode-string-arrays statically resolves provider, offset and literal index', () => {
  const { code } = assertPreserved(`${decoder} globalThis.result = decode(16);`, options);
  assert.match(code, /result\s*=\s*['"]hello['"]/);
});

test('decoder aliases are resolved by binding', () => {
  const { code } = assertPreserved(`${decoder} var alias = decode; globalThis.result = alias(17);`, options);
  assert.match(code, /result\s*=\s*['"]world['"]/);
});

test('a dynamically indexed decoder call is retained', () => {
  const { code } = deobfuscate(`${decoder} globalThis.result = decode(globalThis.dynamicIndex);`, options);
  assert.match(code, /decode\(globalThis\.dynamicIndex\)/);
});

test('a reassigned decoder alias is not treated as the original helper', () => {
  assertPreserved(`${decoder}
    var alias = decode;
    alias = function () { return 'replacement'; };
    globalThis.result = alias(16);
  `, options);
});

test('a shadowed decoder name is a different binding', () => {
  assertPreserved(`${decoder}
    function nested(decode) { return decode(16); }
    globalThis.result = nested(function () { return 'shadow'; });
  `, options);
});

test('an invalid array index does not become an invented string', () => {
  assertPreserved(`${decoder} globalThis.result = [decode(15), decode(999), decode(16.5)];`, options);
});

test('a decoder with externally visible writes retains those effects', () => {
  assertPreserved(`
    globalThis.trace = [];
    function table() { var entries = ['hello']; return entries; }
    function decode(index) { var entries = table(); globalThis.trace[0] = 'called'; return entries[index - 16]; }
    globalThis.result = decode(16);
  `, options);
});

test('conditional provider returns cannot be replaced by one discovered array', () => {
  assertPreserved(`
    globalThis.flag = true;
    function table() { var entries = ['hello']; if (globalThis.flag) return []; return entries; }
    function decode(index) { var entries = table(); return entries[index - 16]; }
    globalThis.result = decode(16);
  `, options);
});

test('decoder operation limits preserve remaining calls and emit a diagnostic', () => {
  const calls = Array.from({ length: 1200 }, () => 'decode(16)').join(',');
  const { code, report } = deobfuscate(`${decoder} globalThis.result = [${calls}];`, {
    ...options, maxDecoderOperations: 1000, maxIterations: 1,
  });
  assert.ok(/decode\(16\)/.test(code), 'Calls beyond the one-pass operation budget should remain');
  assert.ok(report.diagnostics.some((item) => item.code === 'STRING_DECODER_OPERATION_LIMIT'));
});

test('lookup followed by string concatenation is not a plain decoder', () => {
  for (const tail of ["return value + '!';", "value += '!'; return value;"]) {
    assertPreserved(`
      function table() { var entries = ['hello']; return entries; }
      function decode(index) { var entries = table(); var value = entries[index - 16]; ${tail} }
      globalThis.result = decode(16);
    `, options);
  }
});

test('memoized table mutation and escaped table aliases prevent decoding', () => {
  for (const mutation of ["table()[0] = 'changed';", "var leaked = table(); leaked[0] = 'changed';"]) {
    assertPreserved(`
      function table() { var entries = ['hello']; table = function () { return entries; }; return table(); }
      function decode(index) { var entries = table(); return entries[index - 16]; }
      ${mutation}
      globalThis.result = decode(16);
    `, options);
  }
});

test('direct eval and with prevent string decoder assumptions', () => {
  for (const dynamicScope of ["eval('');", "with ({}) {};"]) {
    const { code, report } = assertPreserved(`${decoder} ${dynamicScope} globalThis.result = decode(16);`, options);
    assert.match(code, /result\s*=\s*decode\(16\)/);
    assert.ok(report.diagnostics.some((item) => item.code === 'UNSUPPORTED_DYNAMIC_SCOPE'));
  }
});

test('self redefining decoder with additional outer return semantics is retained', () => {
  assertPreserved(`
    function table() { var entries = ['hello']; return entries; }
    function decode(index) {
      var entries = table();
      decode = function (value) { return entries[value - 16]; };
      return decode(index) + '!';
    }
    globalThis.result = decode(16);
  `, options);
});

test('rotation state applies only to calls occurring after the rotation', () => {
  const { code } = assertPreserved(`
    function table() { var entries = ['foo', '2', '1']; table = function () { return entries; }; return table(); }
    function decode(index) { var entries = table(); return entries[index - 16]; }
    const early = decode(16);
    (function (provider, target) {
      var entries = provider();
      while (!![]) {
        try {
          if (parseInt(decode(16)) === target) break;
          else entries.push(entries.shift());
        } catch (error) { entries.push(entries.shift()); }
      }
    })(table, 1);
    const late = decode(16);
    globalThis.result = [early, late];
  `, options);
  assert.match(code, /early\s*=\s*decode\(16\)/);
  assert.match(code, /late\s*=\s*['"]1['"]/);
});
