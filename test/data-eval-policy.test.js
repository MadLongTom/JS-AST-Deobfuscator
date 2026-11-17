'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { deobfuscate } = require('../src');
const { analyzeDynamicScope } = require('../src/passes/_dynamic-scope');
const { assertPreserved, observeTrustedProgram } = require('./helpers');

const readable = { profile: 'readable', assumeDataEval: true };
const decoder = `
  function table() { var entries = ['hello', 'world']; return entries; }
  function decode(index) { var entries = table(); return entries[index - 16]; }
`;

function inspect(source, enabled = true) {
  const ast = parser.parse(source, { sourceType: 'script' });
  const bindings = [], functions = new Map();
  traverse(ast, {
    Identifier(path) {
      if (!path.isBindingIdentifier()) return;
      const binding = path.scope.getBinding(path.node.name);
      if (binding && !bindings.includes(binding)) bindings.push(binding);
    },
    FunctionDeclaration(path) { functions.set(path.node.id.name, path); },
  });
  const context = { options: { profile: 'readable', assumeDataEval: enabled } };
  return {
    ast,
    analysis: analyzeDynamicScope(ast, { context }),
    functions,
    binding: (name, owner) => bindings.find(binding => binding.identifier.name === name &&
      (!owner || binding.scope.path.isFunction() && binding.scope.path.node.id && binding.scope.path.node.id.name === owner)),
  };
}

function evalArguments(source) {
  const result = [];
  const strip = value => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== 'object') return value;
    const node = Object.fromEntries(Object.entries(value).filter(([key]) => !['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)).map(([key, item]) => [key, strip(item)]));
    // Pure literal concatenation may be folded while preserving the exact
    // source text sent to eval. Dynamic expressions must keep their AST shape.
    if (node.type === 'BinaryExpression' && node.operator === '+' && node.left.type === 'StringLiteral' && node.right.type === 'StringLiteral') {
      return { type: 'StringLiteral', value: node.left.value + node.right.value };
    }
    return node;
  };
  traverse(parser.parse(source, { sourceType: 'script' }), {
    CallExpression(path) {
      if (path.get('callee').isIdentifier({ name: 'eval' })) result.push(strip(path.node.arguments));
    },
  });
  return result;
}

test('data-eval API defaults to the same conservative output as explicit false', () => {
  const source = `(function () { ${decoder} var payload = '{"value":1}'; eval('(' + payload + ')'); globalThis.result = decode(16); })();`;
  for (const profile of ['safe', 'readable']) {
    const omitted = deobfuscate(source, { profile, passes: ['decode-string-arrays'] });
    const disabled = deobfuscate(source, { profile, assumeDataEval: false, passes: ['decode-string-arrays'] });
    assert.equal(omitted.code, disabled.code);
    assert.deepEqual(omitted.report.assumptions, []);
    assert.deepEqual(disabled.report.assumptions, []);
    assert.match(omitted.code, /result\s*=\s*decode\(16\)/);
    assert.ok(omitted.report.diagnostics.some(item => item.code === 'UNSUPPORTED_DYNAMIC_SCOPE'));
  }
});

test('data-eval API rejects safe-profile and nonboolean opt-in', () => {
  for (const options of [
    { assumeDataEval: true },
    { profile: 'safe', assumeDataEval: true },
    { profile: 'readable', assumeDataEval: 'true' },
    { profile: 'readable', assumeDataEval: 1 },
  ]) assert.throws(() => deobfuscate('var value = 1;', options), error => error.code === 'INVALID_OPTIONS');
});

test('data-eval opt-in unlocks parenthesized data decoding and records a nonproof diagnostic', () => {
  const source = `(function () { ${decoder} var payload = '{"value":1}'; var parsed = eval('(' + payload + ')'); globalThis.result = [decode(16), parsed.value]; })();`;
  const { code, report } = assertPreserved(source, { ...readable, passes: ['decode-string-arrays'] });
  assert.doesNotMatch(code, /\[decode\(16\)/);
  assert.match(code, /\["hello"/);
  assert.equal(report.assumptions.length, 1);
  assert.equal(report.assumptions[0].kind, 'parenthesized-expression');
  assert.equal(report.assumptions[0].proven, false);
  assert.ok(report.diagnostics.some(item => item.code === 'ASSUMED_DATA_EVAL'));
  assert.deepEqual(evalArguments(code), evalArguments(source));
});

test('data-eval classification is per site: an unrestricted eval in the same scope still blocks decoding', () => {
  const source = `(function () { ${decoder} var payload = '{}', code = 'void 0'; eval('(' + payload + ')'); eval(code); globalThis.result = decode(16); })();`;
  const result = assertPreserved(source, { ...readable, passes: ['decode-string-arrays'] });
  assert.match(result.code, /result\s*=\s*decode\(16\)/);
  assert.equal(result.report.assumptions.length, 1);
  assert.ok(result.report.diagnostics.some(item => item.code === 'UNSUPPORTED_DYNAMIC_SCOPE'));
  assert.deepEqual(evalArguments(result.code), evalArguments(source));
});

test('data-eval opt-in does not weaken with or a locally bound eval name', () => {
  for (const tail of [
    "with ({}) { eval('(' + payload + ')'); }",
    "(function (eval) { eval('(' + payload + ')'); })(globalThis.eval);",
  ]) {
    const source = `(function () { ${decoder} var payload = '{}'; ${tail} globalThis.result = decode(16); })();`;
    const { code, report } = assertPreserved(source, { ...readable, passes: ['decode-string-arrays'] });
    assert.match(code, /result\s*=\s*decode\(16\)/);
    assert.deepEqual(report.assumptions, []);
  }
});

test('an assumed eval does not exempt an independent sibling function hazard', () => {
  const source = `
    function clean() { ${decoder} var payload = '{}'; eval('(' + payload + ')'); return decode(16); }
    function dirty() { ${decoder} var code = 'void 0'; eval(code); return decode(17); }
    globalThis.result = [clean(), dirty()];
  `;
  const { code } = assertPreserved(source, { ...readable, passes: ['decode-string-arrays'] });
  assert.match(code, /return "hello"/);
  assert.match(code, /return decode\(17\)/);
});

test('declaration-form analysis retains a variable-scope barrier but only protects introduced binding names', () => {
  const { analysis, binding, functions } = inspect(`function f(payload) { var data = 1, unrelated = 2; eval('var data=' + payload); return [data, unrelated]; }`);
  assert.equal(analysis.assumed.length, 1);
  assert.equal(analysis.hazards.length, 1);
  assert.equal(analysis.hasAny, true);
  assert.equal(analysis.affectsBinding(binding('data')), true);
  assert.equal(analysis.affectsBinding(binding('unrelated')), false);
  assert.equal(analysis.affectsPath(binding('unrelated').path), true);
  assert.equal(analysis.affectsRegion(functions.get('f')), true);
  assert.deepEqual(analysis.hazards[0].introducedNames, ['data']);
});

test('declaration-form analysis protects the visible outer name that eval will shadow', () => {
  const { analysis, binding } = inspect(`function outer() { const data = 41, unrelated = 2; function inner(payload) { eval('var data=' + payload); return data; } return inner; }`);
  assert.equal(analysis.affectsBinding(binding('data', 'outer')), true);
  assert.equal(analysis.affectsBinding(binding('unrelated', 'outer')), false);
});

test('declaration-form analysis distinguishes a hidden outer binding from the nearest same-name parameter', () => {
  const { analysis, binding } = inspect(`function outer() { const data = 41; function inner(data, payload) { eval('var data=' + payload); return data; } return inner; }`);
  assert.equal(analysis.affectsBinding(binding('data', 'outer')), false);
  assert.equal(analysis.affectsBinding(binding('data', 'inner')), true);
});

for (const [label, source] of [
  ['an existing local var', `(function () { var data = 41; eval('var data=' + '{"value":7}'); globalThis.result = data.value; })();`],
  ['a parameter and its snapshot alias', `function f(d, payload) { var alias = d; eval('var d=' + payload); return [alias, d]; } globalThis.result = f(9, '7');`],
  ['an outer constant shadowed by eval', `(function () { const data = 41; function f(payload) { eval('var data=' + payload); return data.value; } globalThis.result = [f('{"value":7}'), data]; })();`],
  ['a same-name lexical binding causing SyntaxError', `(function () { const data = 41; eval('var data=' + '{"value":7}'); globalThis.result = data; })();`],
  ['strict eval declarations remaining private', `(function () { 'use strict'; var data = 41; eval('var data=' + '{"value":7}'); globalThis.result = data; })();`],
]) test(`data-eval preserves ${label}`, () => {
  const { code } = assertPreserved(source, { ...readable, renameBindings: true });
  assert.deepEqual(evalArguments(code), evalArguments(source));
});

test('declaration eval keeps callback parameter, local names and introduced free references during rename', () => {
  const source = `function callback(_0xpayload) { var _0xlocal = 4; eval('var data=' + _0xpayload); return [_0xlocal, data]; } globalThis.result = callback('7');`;
  const { code, report } = assertPreserved(source, { ...readable, renameBindings: true, passes: ['inline-constants', 'inline-aliases'] });
  assert.match(code, /callback\(_0xpayload\)/);
  assert.match(code, /var _0xlocal/);
  assert.match(code, /\[_0xlocal, data\]/);
  assert.deepEqual(evalArguments(code), evalArguments(source));
  assert.ok(report.assumptions.some(item => item.introducedNames.includes('data')));
});

test('declaration eval preserves one property read and its original string coercion ordering', () => {
  const source = `(function () {
    globalThis.trace = [];
    var response = { get body() { trace.push('get'); return { toString: function () { trace.push('coerce:' + typeof data); return '{"value":7}'; } }; } };
    eval('var data=' + response.body);
    globalThis.result = [data.value, trace.length];
  })();`;
  const original = observeTrustedProgram(source);
  assert.equal(original.exception, null);
  assert.equal(original.trace, '["get","coerce:undefined"]');
  const { code } = assertPreserved(source, readable);
  assert.deepEqual(evalArguments(code), evalArguments(source));
});

test('parenthesized eval keeps JavaScript data semantics including __proto__ and negative zero', () => {
  const source = `(function () {
    var payload = '{"__proto__":{"inherited":7},"value":-0,"list":[true,false,null,"x"]}';
    var parsed = eval('(' + payload + ')');
    globalThis.result = [parsed.inherited, Object.prototype.hasOwnProperty.call(parsed, '__proto__'), Object.is(parsed.value, -0), parsed.list];
  })();`;
  const { code } = assertPreserved(source, readable);
  assert.match(code, /eval\(/);
  assert.doesNotMatch(code, /JSON\.parse/);
});

for (const [label, source] of [
  ['decoder', `(function () { function table() { var entries = ['hello']; return entries; } function data(index) { var entries = table(); return entries[index - 16]; } var payload = '7'; eval('var data=' + payload); globalThis.result = data(16); })();`],
  ['provider', `(function () { ${decoder} var payload = '7'; eval('var table=' + payload); globalThis.result = decode(16); })();`],
  ['decoder alias', `(function () { ${decoder} var data = decode, payload = '7'; eval('var data=' + payload); globalThis.result = data(16); })();`],
]) test(`introduced-name collision with a ${label} retains the original callable lookup`, () => {
  const { code } = assertPreserved(source, { ...readable, passes: ['decode-string-arrays', 'cleanup-decoders'] });
  assert.match(code, label === 'provider' ? /result\s*=\s*decode\(16\)/ : /result\s*=\s*data\(16\)/);
  assert.equal(observeTrustedProgram(code).exception, 'TypeError');
});

test('literal decoder replacement may cross a names-only path barrier without removing it', () => {
  const source = `(function () { ${decoder} var payload = '{"value":7}'; eval('var data=' + payload); globalThis.result = [decode(16), data.value]; })();`;
  const { code, report } = assertPreserved(source, { ...readable, passes: ['decode-string-arrays', 'cleanup-decoders'] });
  assert.match(code, /\["hello", data\.value\]/);
  assert.doesNotMatch(code, /function decode\b|function table\b/);
  assert.deepEqual(evalArguments(code), evalArguments(source));
  assert.ok(report.assumptions.some(item => item.kind === 'variable-declaration'));
});

test('one opt-in call does not leak policy into a later default invocation', () => {
  const source = `(function () { ${decoder} var payload = '{}'; eval('(' + payload + ')'); globalThis.result = decode(16); })();`;
  const options = { profile: 'readable', passes: ['decode-string-arrays'] };
  const before = deobfuscate(source, options);
  deobfuscate(source, { ...options, assumeDataEval: true });
  const after = deobfuscate(source, options);
  assert.equal(after.code, before.code);
  assert.deepEqual(after.report.assumptions, []);
});
