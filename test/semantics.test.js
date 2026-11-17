'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertPreserved, observeTrustedProgram } = require('./helpers.js');

const cases = [
  ['arithmetic, coercion, short circuit, and negative zero', `
    globalThis.result = [1 + 2 * 3, '2' + 3, 2 == '2', 0 || 7,
      false && missing(), true ? 'yes' : missing(), 1 / -0,
      Number.isNaN(0 / 0), typeof undefined];
  `],
  ['escaped text remains text and is not decoded twice', String.raw`
    globalThis.result = ['\u4e2d\u6587', '\\u4e2d', '\x41', '\\x41', 'a\\nb'];
  `],
  ['assignment and update prevent constant propagation', `
    (function () { let n = 1; n = 2; const before = n++; globalThis.result = [before, n]; })();
  `],
  ['var reads before initialization stay undefined', `
    (function () { globalThis.result = [n, typeof n]; var n = 42; })();
  `],
  ['const temporal dead zone is preserved', `
    (function () { globalThis.result = value; const value = 42; })();
  `],
  ['let temporal dead zone is preserved', `
    (function () { globalThis.result = value; let value = 42; })();
  `],
  ['self referencing initializer still throws', `
    (function () { const value = value; globalThis.result = value; })();
  `],
  ['closure can run before the captured declaration', `
    (function () { function read() { return value; } globalThis.result = read(); const value = 42; })();
  `],
  ['per iteration lexical bindings remain distinct', `
    globalThis.result = [];
    const callbacks = [];
    for (let i = 0; i < 3; i++) callbacks.push(function () { return i; });
    for (const callback of callbacks) result.push(callback());
  `],
  ['object writes prevent property propagation', `
    (function () { const table = { value: 'first' }; table.value = 'second'; globalThis.result = table.value; })();
  `],
  ['escaped object aliases can mutate properties', `
    (function () { const table = { value: 'first' }; const alias = table;
      alias.value = 'second'; globalThis.result = table.value; })();
  `],
  ['getters retain their read effects', `
    globalThis.trace = [];
    (function () { const table = { get value() { trace.push('get'); return 3; } };
      globalThis.result = table.value + table.value; })();
  `],
  ['prototype properties are not literal own properties', `
    (function () { const table = { __proto__: { value: 9 }, own: 1 };
      globalThis.result = [table.value, table.own]; })();
  `],
  ['repeated wrapper parameters do not repeat argument effects', `
    globalThis.trace = [];
    (function () { function twice(x) { return x + x; }
      function next() { trace.push('next'); return trace.length; }
      globalThis.result = twice(next()); })();
  `],
  ['unused wrapper arguments still run', `
    globalThis.trace = [];
    (function () { function first(a, b) { return a; }
      globalThis.result = first((trace.push('a'), 1), (trace.push('b'), 2)); })();
  `],
  ['argument evaluation order differs from return operand order', `
    globalThis.trace = [];
    (function () { function reverse(a, b) { return b + a; }
      globalThis.result = reverse((trace.push('a'), 'A'), (trace.push('b'), 'B')); })();
  `],
  ['extra arguments retain their effects', `
    globalThis.trace = [];
    (function () { function identity(a) { return a; }
      globalThis.result = identity(1, trace.push('extra')); })();
  `],
  ['missing arguments preserve undefined coercion', `
    (function () { function add(a, b) { return a + b; }
      globalThis.result = Number.isNaN(add(1)); })();
  `],
  ['wrappers using this keep their receiver', `
    (function () { const object = { value: 7, read: function () { return this.value; } };
      globalThis.result = object.read(); })();
  `],
  ['wrappers using arguments keep their arguments object', `
    (function () { function read(a) { return arguments.length + a; }
      globalThis.result = read(3, 4); })();
  `],
  ['helpers are resolved by binding rather than spelling', `
    (function () { function add(a, b) { return a + b; }
      function nested(add) { return add(2, 3); }
      globalThis.result = [add(2, 3), nested(function (a, b) { return a * b; })]; })();
  `],
  ['direct eval can read apparently unused local bindings', `
    (function () { var secret = 7; globalThis.result = eval('secret'); })();
  `],
  ['direct eval can mutate a binding before its later read', `
    (function () { var secret = 7; eval('secret = 9'); globalThis.result = secret; })();
  `],
  ['top level function and var remain externally visible', `
    var publicValue = 7;
    function publicFunction() { return publicValue; }
    globalThis.result = [globalThis.publicValue, globalThis.publicFunction()];
  `],
  ['unreachable var declaration still hoists', `
    (function () { globalThis.result = hidden; if (false) { var hidden = 2; } })();
  `],
  ['var after return is still hoisted', `
    function read() { return hidden; var hidden = 2; }
    globalThis.result = read();
  `],
  ['false loop body still hoists var declarations', `
    (function () { globalThis.result = hidden; while (false) { var hidden = 2; } })();
  `],
  ['branch simplification retains block scope', `
    (function () { const value = 'outer'; if (true) { const value = 'inner'; }
      globalThis.result = value; })();
  `],
  ['discarded declarations retain initializer side effects', `
    globalThis.trace = [];
    (function () { const unused = trace.push('initialized'); globalThis.result = trace.length; })();
  `],
  ['shadowed builtins are not evaluated as globals', `
    (function () { function parseInt() { return 99; }
      const Math = { max: function () { return 88; } };
      globalThis.result = [parseInt('12'), Math.max(1, 2)]; })();
  `],
  ['simplified conditional callees still produce unbound values', `
    (function () { 'use strict'; const object = { value: 7, read: function () { return this === undefined; } };
      globalThis.result = (true ? object.read : null)(); })();
  `],
  ['simplified logical callees still produce unbound values', `
    (function () { 'use strict'; const object = { value: 7, read: function () { return this === undefined; } };
      globalThis.result = (true && object.read)(); })();
  `],
  ['conditional eval callees remain indirect eval', `
    var visible = 'global';
    (function () { var visible = 'local'; globalThis.result = (true ? eval : null)('visible'); })();
  `],
  ['delete of a conditional value does not delete its selected member', `
    const object = { value: 7 };
    globalThis.result = [delete (true ? object.value : 0), object.value];
  `],
  ['sloppy block function remains visible through its Annex B binding', `
    (function () { { function blockFunction() {} } globalThis.result = typeof blockFunction; })();
  `],
  ['typeof conditional value still throws for an unresolved name', `
    globalThis.result = typeof (true ? missingName : 1);
  `],
  ['typeof logical value still throws for an unresolved name', `
    globalThis.result = typeof (true && missingName);
  `],
];

for (const [name, source] of cases) {
  test(`preserves semantics: ${name}`, () => assertPreserved(source));
}

test('semantic observations distinguish special numbers rather than JSON null', () => {
  const values = ['0', '-0', 'NaN', 'Infinity', '-Infinity', 'undefined', 'null'];
  const results = values.map((value) => observeTrustedProgram(`globalThis.result = ${value};`).result);
  assert.equal(new Set(results).size, values.length);
});

test('multiple iterations preserve behavior and settle into a stable form', () => {
  const source = '(function () { const value = 0x10; globalThis.result = value + (2 * 3); })();';
  const first = assertPreserved(source);
  const second = assertPreserved(first.code);
  assert.equal(second.code, first.code);
});
