'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const { t, traverse, analyzeDynamicScope, dynamicScope } = require('../src/passes/_utils');
const { observeTrustedProgram } = require('./helpers');

function inspect(source, options) {
  const ast = parser.parse(source, { sourceType: 'script', ...options });
  const bindings = [], functions = new Map();
  traverse(ast, {
    Identifier(path) {
      if (!path.isBindingIdentifier()) return;
      const binding = path.scope.getBinding(path.node.name);
      if (binding && !bindings.includes(binding)) bindings.push(binding);
    },
    FunctionDeclaration(path) { functions.set(path.node.id.name, path); },
  });
  const binding = (name, owner) => bindings.find(value => value.identifier.name === name && (!owner || value.scope.path.isFunction() && value.scope.path.node.id && value.scope.path.node.id.name === owner));
  return { ast, binding, functions };
}

test('dynamic scope: unrelated sibling eval permits a private local binding', () => {
  const { ast, binding, functions } = inspect('function dirty(){eval("unknownCode")}function clean(){const safe=7;return safe}');
  const analysis = analyzeDynamicScope(ast);
  assert.equal(analysis.hasAny, true);
  assert.equal(analysis.affectsBinding(binding('safe')), false);
  assert.equal(analysis.affectsPath(binding('safe').path), false);
  assert.equal(analysis.affectsRegion(functions.get('clean')), false);
  assert.equal(analysis.affectsRegion(functions.get('dirty')), true);
});

test('dynamic scope: eval in a descendant still sees and can mutate ancestor bindings', () => {
  const { ast, binding } = inspect('(function outer(){const secret=7;function nested(){eval("secret")};return secret})()');
  const analysis = analyzeDynamicScope(ast);
  assert.equal(analysis.affectsBinding(binding('secret')), true);
  assert.equal(analysis.explainBinding(binding('secret'))[0].type, 'eval');
});

test('dynamic scope: shadowing a name isolates only the hidden ancestor binding', () => {
  const { ast, binding } = inspect('function outer(){const hidden=7;function nested(hidden){eval("hidden=9")};return hidden}');
  const analysis = analyzeDynamicScope(ast);
  assert.equal(analysis.affectsBinding(binding('hidden', 'outer')), false);
  assert.equal(analysis.affectsBinding(binding('hidden', 'nested')), true);
});

test('dynamic scope: outer eval can observe a private function binding but not its inaccessible locals', () => {
  const { ast, binding } = inspect('function outer(){function clean(){let privateValue=7;return privateValue}eval("clean")};');
  const analysis = analyzeDynamicScope(ast);
  assert.equal(analysis.affectsBinding(binding('clean')), true);
  assert.equal(analysis.affectsBinding(binding('privateValue')), false);
  // A destination in this nested scope still needs protection against names
  // which the enclosing eval may introduce; binding and path queries differ.
  assert.equal(analysis.affectsPath(binding('privateValue').path), true);
});

test('dynamic scope: strict direct eval remains able to observe lexical bindings', () => {
  const { ast, binding } = inspect('function outer(){"use strict";let secret=7;eval("secret=9");return secret}');
  assert.equal(analyzeDynamicScope(ast).affectsBinding(binding('secret')), true);
});

test('dynamic scope: a locally named eval may still hold the intrinsic eval', () => {
  const { ast, binding } = inspect('function outer(eval){let secret=7;eval("secret=9");return secret}');
  assert.equal(analyzeDynamicScope(ast).affectsBinding(binding('secret')), true);
});

test('dynamic scope: parenthesized direct eval is recognized with explicit parentheses nodes', () => {
  const { ast, binding } = inspect('function outer(){let secret=7;(eval)("secret=9");return secret}', { createParenthesizedExpressions: true });
  assert.equal(analyzeDynamicScope(ast).affectsBinding(binding('secret')), true);
});

test('dynamic scope: optional, member and comma eval calls do not access local lexical bindings', () => {
  for (const call of ['eval?.("secret")', '(0,eval)("secret")', 'globalThis.eval("secret")', '(true?eval:null)("secret")']) {
    const { ast, binding } = inspect(`function outer(){let secret=7;${call};return secret}`);
    const analysis = analyzeDynamicScope(ast);
    assert.equal(analysis.hasAny, false, call);
    assert.equal(analysis.affectsBinding(binding('secret')), false, call);
  }
});

test('dynamic scope: eval can introduce names into its function outside the textual block', () => {
  const { ast, functions } = inspect('function outer(){if(flag){eval(code)}return maybeInjected}function unrelated(){return maybeInjected}');
  const analysis = analyzeDynamicScope(ast);
  assert.equal(analysis.affectsPath(functions.get('outer').get('body.body.1.argument')), true);
  assert.equal(analysis.affectsPath(functions.get('unrelated').get('body.body.0.argument')), false);
});

test('dynamic scope: a with body and visible ancestor bindings remain protected', () => {
  const { ast, binding, functions } = inspect('function dirty(){let visible=7;with(object){var insideValue=visible;result=insideValue}}function clean(){let separate=8;return separate}');
  const analysis = analyzeDynamicScope(ast);
  assert.equal(analysis.affectsBinding(binding('visible')), true);
  assert.equal(analysis.affectsBinding(binding('insideValue')), true);
  assert.equal(analysis.affectsBinding(binding('separate')), false);
  assert.equal(analysis.affectsPath(functions.get('dirty').get('body.body.1.body')), true);
  assert.equal(analysis.affectsRegion(functions.get('clean')), false);
});

test('dynamic scope: a with body local lexical binding is conservatively retained', () => {
  const { ast, binding } = inspect('function outer(){with(object){let local=7;result=local}}');
  assert.equal(analyzeDynamicScope(ast).affectsBinding(binding('local')), true);
});

test('dynamic scope: a proof hook ignores only specifically selected direct eval nodes', () => {
  const { ast, binding } = inspect('function outer(){let secret=7;eval("safe-by-external-proof");eval(untrusted);return secret}');
  const selected = new Set();
  traverse(ast, { CallExpression(path) { if (t.isStringLiteral(path.node.arguments[0])) selected.add(path.node); } });
  const analysis = analyzeDynamicScope(ast, { ignoreEval: path => selected.has(path.node) });
  assert.equal(analysis.ignored.length, 1);
  assert.equal(analysis.hazards.length, 1);
  assert.equal(analysis.affectsBinding(binding('secret')), true);
  assert.equal(analyzeDynamicScope(ast, { ignoreEval: () => 'truthy-is-not-proof' }).hazards.length, 2);
  assert.equal(analyzeDynamicScope(ast).hazards.length, 2);
});

const validatedJson = String.raw`
(function outer() {
  var secret = 7;
  var punctuation = /^[\],:{}\s]*$/;
  var escapes = /\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g;
  var values = /"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g;
  var brackets = /(?:^|:|,)(?:\s*\[)+/g;
  function parse(text) {
    if (text = String(text), punctuation.test(text.replace(escapes, '@').replace(values, ']').replace(brackets, '')))
      return eval('(' + text + ')');
    throw new SyntaxError('JSON.parse');
  }
})();`;

test('dynamic scope: strict JSON2 recognition is the only built-in data-only exception', () => {
  const { ast, binding } = inspect(validatedJson);
  const analysis = analyzeDynamicScope(ast);
  assert.equal(analysis.hasAny, false);
  assert.equal(analysis.restricted.length, 1);
  assert.equal(analysis.ignored[0].reason, 'restricted-json');
  assert.equal(analysis.affectsBinding(binding('secret')), false);
  const altered = inspect(validatedJson.replace('text = String(text), ', ''));
  assert.equal(analyzeDynamicScope(altered.ast).hasAny, true);
});

test('dynamic scope: recognizing a JSON parser does not exempt another eval in its scope', () => {
  const { ast, binding } = inspect(validatedJson.replace('var secret = 7;', 'var secret = 7; function unrestricted(code){eval(code)}'));
  const analysis = analyzeDynamicScope(ast);
  assert.equal(analysis.restricted.length, 1);
  assert.equal(analysis.hazards.length, 1);
  assert.equal(analysis.affectsBinding(binding('secret')), true);
});

test('dynamic scope: snapshots can analyze a NodePath subtree including its root hazard', () => {
  const { ast, binding } = inspect('function outer(){let secret=7;eval(code);return secret}');
  const analysis = analyzeDynamicScope(ast);
  const path = analysis.hazards[0].path;
  assert.equal(analyzeDynamicScope(path).hazards.length, 1);
  assert.equal(analyzeDynamicScope(path).affectsBinding(binding('secret')), true);
});

test('dynamic scope: the legacy API retains its whole-program boolean and warning', () => {
  const { ast } = inspect('function dirty(){eval(code)}function clean(){return 7}');
  const warnings = [];
  assert.equal(dynamicScope(ast, { warn: (...args) => warnings.push(args) }, 'example'), true);
  assert.equal(warnings[0][0], 'DYNAMIC_SCOPE');
  assert.equal(dynamicScope(parser.parse('function clean(){return 7}')), false);
});

// Exercise the public analysis against actual eval/with behavior using only
// these trusted synthetic strings. No vendor fixture is executed by this test.
function replaceSafePrimitiveBindings(source) {
  const { ast } = inspect(source);
  const analysis = analyzeDynamicScope(ast);
  traverse(ast, { VariableDeclarator(path) {
    if (!t.isIdentifier(path.node.id) || !t.isNumericLiteral(path.node.init)) return;
    const binding = path.scope.getBinding(path.node.id.name);
    if (!binding || !binding.constant || analysis.affectsBinding(binding)) return;
    for (const reference of binding.referencePaths) reference.replaceWith(t.cloneNode(path.node.init));
    if (path.parentPath.node.declarations.length === 1) path.parentPath.remove(); else path.remove();
  } });
  return generate(ast).code;
}

for (const [name, source] of [
  ['a sibling eval and a safe local constant', 'function dirty(){eval("var other=4")}function clean(){const safe=7;return safe}dirty();globalThis.result=clean()'],
  ['a nested eval mutating its ancestor', 'function outer(){let secret=7;function inner(){eval("secret=9")}inner();return secret}globalThis.result=outer()'],
  ['a binding visible only to eval', 'function outer(){const secret=7;return eval("secret")}globalThis.result=outer()'],
  ['with overriding an outer lexical read', 'function outer(){const secret=7;with({secret:9}){return secret}}globalThis.result=outer()'],
]) test(`dynamic scope: trusted semantics preserve ${name}`, () => {
  const code = replaceSafePrimitiveBindings(source);
  assert.deepEqual(observeTrustedProgram(code), observeTrustedProgram(source));
  if (name === 'a sibling eval and a safe local constant') assert.doesNotMatch(code, /const safe/);
});
