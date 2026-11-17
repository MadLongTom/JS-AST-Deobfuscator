'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { isRestrictedJsonEval } = require('../src/analysis/restricted-json-eval');

const source = String.raw`
(function () {
  var punctuation = /^[\],:{}\s]*$/;
  var escapes = /\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g;
  var values = /"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g;
  var brackets = /(?:^|:|,)(?:\s*\[)+/g;
  function parse(text) {
    var result;
    if (text = String(text), punctuation.test(text.replace(escapes, '@').replace(values, ']').replace(brackets, '')))
      return result = eval('(' + text + ')'), result;
    throw new SyntaxError('JSON.parse');
  }
})();`;

function classify(code, resolver) {
  const result = [];
  traverse(parser.parse(code), { CallExpression(path) {
    if (path.get('callee').isIdentifier({ name: 'eval' })) result.push(isRestrictedJsonEval(path, resolver));
  } });
  return result;
}

test('recognizes the exact data-only JSON2 validation chain without executing it', () => {
  assert.deepEqual(classify(source), [true]);
});

test('supports computed property names only through an explicit static resolver', () => {
  const code = source.replaceAll('.replace(', '[decode(1)](').replace('.test(', '[decode(2)](');
  assert.deepEqual(classify(code), [false]);
  assert.deepEqual(classify(code, path => path.isCallExpression() && path.get('callee').isIdentifier({ name: 'decode' }) ? ({ 1: 'replace', 2: 'test' })[path.node.arguments[0].value] : undefined), [true]);
});

test('accepts canonical JSON2 character normalization before validation', () => {
  const normalized = source.replace('var brackets =', 'var chars = /[\\u0000\\u00ad]/g; var brackets =').replace(
    'text = String(text), punctuation.test',
    String.raw`text = String(text), chars.lastIndex = 0, chars.test(text) && (text = text.replace(chars, function (character) { return '\\u' + ('0000' + character.charCodeAt(0).toString(16)).slice(-4); })), punctuation.test`
  );
  assert.deepEqual(classify(normalized), [true]);
  assert.deepEqual(classify(normalized.replace("return '\\\\u' +", "return evil() +")), [false]);
});

test('rejects altered grammar, ordering, replacements and input coercion', () => {
  for (const changed of [
    source.replace('^[\\],:{}\\s]*$', '.*'),
    source.replace("replace(escapes, '@')", "replace(escapes, '')"),
    source.replace("replace(values, ']').replace(brackets, '')", "replace(brackets, '').replace(values, ']')"),
    source.replace('text = String(text), ', ''),
    source.replace('text = String(text), ', 'text = String(text), text = evil(), '),
    source.replace("return result = eval", "return text = 'evil()', result = eval"),
    source.replace('function parse(text)', 'function parse(text, String)'),
    source.replace('function parse(text)', 'function parse(text, eval)'),
    source.replace('return result = eval', 'return result = eval').replace("'(' + text + ')'", "'(' + other + ')'"),
  ]) assert.deepEqual(classify(changed), [false]);
});

test('rejects escaped regexes and explicit intrinsic mutation', () => {
  for (const extra of [
    'leak(values);',
    'String.prototype.replace = evil;',
    'RegExp.prototype.test = evil;',
    "Object.defineProperty(RegExp.prototype, 'test', {value: evil});",
  ]) assert.deepEqual(classify(source.replace('function parse(text)', `${extra} function parse(text)`)), [false]);
});

test('unrestricted eval and post-validation callbacks remain dynamic', () => {
  assert.deepEqual(classify("function f(text) { return eval('(' + text + ')'); }"), [false]);
  assert.deepEqual(classify(source.replace('return result = eval', 'return mutate(), result = eval')), [false]);
});
