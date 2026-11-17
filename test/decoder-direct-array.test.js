'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deobfuscate } = require('../src');
const { decodeBase64 } = require('../src/decoders/strings');

const alphabet = 'kyclmxfigrhbswquanzevpjotdKYCLMXFIGRHBSWQUANZEVPJOTD0123456789+/=';
const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const options = { passes: ['decode-string-arrays'], maxIterations: 2 };
const encode = value => Buffer.from(value, 'utf8').toString('base64').replace(/=+$/, '')
  .split('').map(character => alphabet[standard.indexOf(character)]).join('');

// These are trusted fixture strings. The decoder pass parses them; neither the
// fixture decoder nor downloaded vendor code is executed by these tests.
function fixture(values = ['hello', '智慧树']) {
  return `var words = ${JSON.stringify(values.map(encode))};
    function decode(index, ignored) {
      index = index - 16;
      var value = words[index];
      if (decode.ready === undefined) {
        var base64 = function(input) {
          var alphabet = ${JSON.stringify(alphabet)};
          var output = '';
          for (var count = 0, bits, digit, cursor = 0;
            digit = input.charAt(cursor++);
            ~digit && (bits = count % 4 ? bits * 64 + digit : digit, count++ % 4)
              ? output += String.fromCharCode(255 & bits >> (-2 * count & 6)) : 0) {
            digit = alphabet.indexOf(digit);
          }
          return output;
        };
        decode.transform = function(input) {
          var bytes = base64(input);
          var encoded = [];
          for (var cursor = 0, length = bytes.length; cursor < length; cursor++) {
            encoded += '%' + ('00' + bytes.charCodeAt(cursor).toString(16)).slice(-2);
          }
          return decodeURIComponent(encoded);
        }, decode.cache = {}, decode.ready = !![];
      }
      var first = words[0], key = index + first, cached = decode.cache[key];
      return cached === undefined
        ? (value = decode.transform(value), decode.cache[key] = value)
        : value = cached, value;
    }`;
}

test('direct array providers support a pure lookup and index offset', () => {
  const { code } = deobfuscate("const words=['one','two']; function decode(index){return words[index-4]} result=decode(5);", options);
  assert.match(code, /result\s*=\s*["']two["']/);
});

test('custom alphabet, split URI helper and property cache decode statically', () => {
  const { code, report } = deobfuscate(`${fixture()} result=[decode(16),decode(17),decode(16)];`, options);
  assert.match(code, /result\s*=\s*\["hello", "智慧树", "hello"\]/);
  assert.equal(report.diagnostics.length, 0);
});

test('binding and private property names can change independently', () => {
  const input = fixture().replace(/\bdecode\b/g, 'lookup').replace(/\bwords\b/g, 'strings')
    .replace(/\.ready/g, "['initialized']").replace(/\.transform/g, "['unpack']")
    .replace(/\.cache/g, "['memo']");
  const { code } = deobfuscate(`${input} var alias=lookup; result=alias(17);`, options);
  assert.match(code, /result\s*=\s*["']智慧树["']/);
});

test('the cached schema also survives statement normalization', () => {
  const { code } = deobfuscate(`${fixture()} result=decode(16);`, {
    passes: ['normalize-literals', 'normalize-statements', 'decode-string-arrays'], maxIterations: 2,
  });
  assert.match(code, /result\s*=\s*["']hello["']/);
});

test('dynamic arguments, invalid indices and shadowed bindings remain calls', () => {
  const { code } = deobfuscate(`${fixture()}
    function inner(decode){return decode(16)}
    result=[decode(globalThis.index),decode(15),decode(100),inner(globalThis.other)];`, options);
  assert.match(code, /decode\(globalThis\.index\)/);
  assert.match(code, /decode\(15\)/);
  assert.match(code, /return decode\(16\)/);
});

test('direct table mutation and escape block constant substitutions', () => {
  for (const mutation of ["words[0]='changed';", 'words.push("changed");', 'globalThis.leak=words;']) {
    const { code, report } = deobfuscate(`${fixture()} ${mutation} result=decode(16);`, options);
    assert.match(code, /result\s*=\s*decode\(16\)/);
    assert.ok(report.diagnostics.some(item => item.code === 'UNSUPPORTED_STRING_TABLE_ESCAPE'));
  }
});

test('observed or externally changed decoder caches stay observable', () => {
  for (const effect of ['decode.cache={};', 'result=decode.cache;', 'globalThis.leak=decode;']) {
    const { code } = deobfuscate(`${fixture()} ${effect} result=decode(16);`, options);
    assert.match(code, /result\s*=\s*decode\(16\)/);
  }
});

test('custom decoder/helper effects and transformations do not match the schema', () => {
  const mutations = [
    source => source.replace('index = index - 16;', 'globalThis.count++; index = index - 16;'),
    source => source.replace('return output;', "return output + '!';"),
    source => source.replace('return decodeURIComponent(encoded);', 'globalThis.count++; return decodeURIComponent(encoded);'),
    source => source.replace('return decodeURIComponent(encoded);', "return decodeURIComponent(encoded) + '!';"),
  ];
  for (const mutate of mutations) {
    const { code } = deobfuscate(`${mutate(fixture())} result=decode(16);`, options);
    assert.match(code, /result\s*=\s*decode\(16\)/);
  }
});

test('direct table initialization order and shadowed URI intrinsic are preserved', () => {
  const early = deobfuscate("result=decode(0);var words=['hello'];function decode(i){return words[i]}", options);
  assert.match(early.code, /result\s*=\s*decode\(0\)/);
  const shadow = deobfuscate(`function outer(decodeURIComponent){${fixture()} result=decode(16);}`, options);
  assert.match(shadow.code, /result\s*=\s*decode\(16\)/);
});

test('intrinsic function properties cannot masquerade as private initialization flags', () => {
  for (const name of ['name', 'prototype', '__proto__', 'toString']) {
    const { code } = deobfuscate(`${fixture().replace(/\.ready/g, '.' + name)} result=decode(16);`, options);
    assert.match(code, /result\s*=\s*decode\(16\)/);
  }
  for (const write of ["String.fromCharCode=function(){return 'x'};", 'Function.prototype.ready=true;',
    "var S=String;S.fromCharCode=function(){return 'x'};",
    "var define=Object.defineProperty;define(String,'fromCharCode',{value:function(){return 'x'}});",
    "var define=Object.defineProperty;define.call(null,String,'fromCharCode',{value:function(){return 'x'}});",
    "var root=globalThis;root.String.fromCharCode=function(){return 'x'};"]) {
    const { code } = deobfuscate(`${fixture()} ${write} result=decode(16);`, options);
    assert.match(code, /result\s*=\s*decode\(16\)/);
  }
});

test('unknown eval visible to a family blocks it, unrelated eval does not', () => {
  const unsafe = deobfuscate(`${fixture()} function unknown(code){eval(code)} result=decode(16);`, options);
  assert.match(unsafe.code, /result\s*=\s*decode\(16\)/);
  assert.ok(unsafe.report.diagnostics.some(item => item.code === 'UNSUPPORTED_DYNAMIC_SCOPE'));
  const alias = deobfuscate(`${fixture()} var alias=decode; function unknown(decode,words,code){eval(code)} result=decode(16);`, options);
  assert.match(alias.code, /result\s*=\s*decode\(16\)/);
  const independent = deobfuscate(`function unknown(code){eval(code)} (function(){${fixture()} result=decode(16)})();`, options);
  assert.match(independent.code, /result\s*=\s*["']hello["']/);
});

test('read-only decoder resolution proves computed JSON2 guard methods before rewriting', () => {
  const json = String.raw`
    var punctuation = /^[\],:{}\s]*$/;
    var escapes = /\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g;
    var values = /"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g;
    var brackets = /(?:^|:|,)(?:\s*\[)+/g;
    function parse(text) {
      var value;
      if (text = String(text), punctuation[decode(17)](text[decode(16)](escapes, '@')[decode(16)](values, ']')[decode(16)](brackets, '')))
        return value = eval('(' + text + ')'), value;
      throw new SyntaxError('JSON.parse');
    }
    result=decode(16);
  `;
  const { code, report } = deobfuscate(fixture(['replace', 'test']) + json, options);
  assert.match(code, /result\s*=\s*["']replace["']/);
  assert.equal(report.diagnostics.length, 0);
  const unsafe = deobfuscate(fixture(['replace', 'test']) + json.replace("(escapes, '@')", "(escapes, '')"), options);
  assert.match(unsafe.code, /result\s*=\s*decode\(16\)/);
});

test('byte-loop encoding is explicit and preserves its distinct padding behavior', () => {
  assert.equal(decodeBase64(encode('智慧树'), alphabet, () => {}, 'byte-loop'), '智慧树');
  assert.equal(decodeBase64('YQ==', standard, () => {}, 'byte-loop'), 'a\u0010@');
  assert.throws(() => decodeBase64('x', 'a'.repeat(64)), /alphabet/);
});

test('bounds preserve oversized and expensive direct-array decodes', () => {
  const input = `${fixture(['a'.repeat(1200)])} result=decode(16);`;
  const length = deobfuscate(input, { ...options, maxDecodedStringLength: 1024 });
  assert.match(length.code, /result\s*=\s*decode\(16\)/);
  assert.ok(length.report.diagnostics.some(item => item.code === 'STRING_DECODER_LENGTH_LIMIT'));
  const operations = deobfuscate(input, { ...options, maxIterations: 1, maxDecoderOperations: 1000 });
  assert.match(operations.code, /result\s*=\s*decode\(16\)/);
  assert.ok(operations.report.diagnostics.some(item => item.code === 'STRING_DECODER_OPERATION_LIMIT'));
});
