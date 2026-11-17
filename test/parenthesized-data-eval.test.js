'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { analyzeDynamicScope } = require('../src/passes/_dynamic-scope');
const { classifyDataEval, createDataEvalPolicy } = require('../src/analysis/parenthesized-data-eval');

function inspect(source, options = {}) {
  const ast = parser.parse(source, { sourceType: 'script', ...options });
  const calls = [];
  traverse(ast, {
    CallExpression(path) { calls.push(path); },
    OptionalCallExpression(path) { calls.push(path); },
  });
  return { ast, calls };
}

test('data eval is an explicit assumption, never a default safety proof', () => {
  const { ast, calls } = inspect("function f(response) { return eval('(' + response.responseText + ')'); }");
  const classification = classifyDataEval(calls[0]);
  assert.equal(classification.kind, 'parenthesized-expression');
  assert.equal(classification.proven, false);
  assert.deepEqual(classification.introducedNames, []);
  assert.equal(classification.inputPath.type, 'MemberExpression');
  const policy = createDataEvalPolicy();
  assert.equal(policy.ignoreEval(calls[0]), false);
  assert.equal(analyzeDynamicScope(ast, policy).hasAny, true);
  assert.equal(policy.assumptions.length, 0);
  assert.equal(createDataEvalPolicy({ assumeDataOnly: 'true' }).ignoreEval(calls[0]), false);
});

test('opt-in exempts only the recognized site and records the data contract once', () => {
  const { ast, calls } = inspect("function f(response, code) { eval('(' + response.body + ')'); eval(code); }");
  const observed = [];
  const policy = createDataEvalPolicy({ assumeDataOnly: true, onAssumption: diagnostic => observed.push(diagnostic) });
  const result = analyzeDynamicScope(ast, policy);
  assert.equal(result.ignored.length, 1);
  assert.equal(result.hazards.length, 1);
  assert.equal(policy.ignoreEval(calls[0]), true);
  assert.equal(policy.assumptions.length, 1);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].code, 'ASSUMED_DATA_EVAL');
  assert.equal(observed[0].proven, false);
  assert.equal(observed[0].assumptions.length, 3);
});

test('a shape match also needs opt-in when its text could observe lexical variables', () => {
  // Merely wrapping this string in parentheses does not prove data-only input.
  // This test parses the fixture and does not evaluate it.
  const { ast, calls } = inspect("function f(secret) { var text = 'secret'; return eval('(' + text + ')'); }");
  assert.equal(classifyDataEval(calls[0]).proven, false);
  assert.equal(analyzeDynamicScope(ast).hazards.length, 1);
});

test('recognizes var declarations but refuses to ignore their injected bindings', () => {
  for (const name of ['d', 'data', 'subs', '结果']) {
    const { ast, calls } = inspect(`function f(response) { eval('var ${name}=' + response.responseText); return ${name}; }`);
    const classification = classifyDataEval(calls[0]);
    assert.equal(classification.kind, 'variable-declaration');
    assert.deepEqual(classification.introducedNames, [name]);
    assert.equal(classification.requiresMaterializedBindings, true);
    const policy = createDataEvalPolicy({ assumeDataOnly: true });
    assert.equal(policy.ignoreEval(calls[0]), false);
    assert.equal(analyzeDynamicScope(ast, policy).hazards.length, 1);
    assert.equal(policy.assumptions.length, 0);
  }
});

test('computed obfuscator prefixes require an explicit effect-free static resolver', () => {
  const { calls } = inspect("function f(response) { eval(prefix(7) + response.body); }");
  assert.equal(classifyDataEval(calls[0]), null);
  const classification = classifyDataEval(calls[0], { resolveString(path) {
    return path.isCallExpression() && path.get('callee').isIdentifier({ name: 'prefix' }) && path.node.arguments[0].value === 7 ? 'var d=' : undefined;
  } });
  assert.deepEqual(classification.introducedNames, ['d']);
});

test('parenthesized callee and input work with explicit parenthesis AST nodes', () => {
  const { calls } = inspect("function f(text) { return (eval)(('(' + (text) + ')')); }", { createParenthesizedExpressions: true });
  assert.equal(classifyDataEval(calls[0]).kind, 'parenthesized-expression');
});

test('unrecognized direct and indirect eval expressions remain protected', () => {
  for (const source of [
    "function f(text) { eval(text); }",
    "function f(text) { eval('(' + text); }",
    "function f(text) { eval('(' + text + ')evil()'); }",
    "function f(text) { eval('var d=evil();' + text); }",
    "function f(text) { eval('let d=' + text); }",
    "function f(text) { eval('var d,other=' + text); }",
    "function f(text) { eval('var arguments=' + text); }",
    "function f(text) { eval('var class=' + text); }",
    "function f(text) { return eval('var d=' + text); }",
    "function f(eval, text) { eval('(' + text + ')'); }",
    "function f(text) { var eval = replacement; eval('(' + text + ')'); }",
    "function f(text) { eval?.('(' + text + ')'); }",
    "function f(text) { (0, eval)('(' + text + ')'); }",
    "function f(text) { globalThis.eval('(' + text + ')'); }",
    "function f(text) { eval('(' + text + ')', 1); }",
    "function f(text) { with (scope) { eval('(' + text + ')'); } }",
  ]) {
    const { calls } = inspect(source);
    assert.ok(calls.length > 0);
    for (const call of calls) assert.equal(classifyDataEval(call), null, source);
  }
});

test('classification does not change the AST or coerce any input object', () => {
  const { ast, calls } = inspect("function f(input) { return eval('(' + input.body + ')'); }");
  const before = JSON.stringify(ast);
  classifyDataEval(calls[0]);
  const policy = createDataEvalPolicy({ assumeDataOnly: true });
  policy.ignoreEval(calls[0]);
  assert.equal(JSON.stringify(ast), before);
});
