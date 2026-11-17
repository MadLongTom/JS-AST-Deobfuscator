'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deobfuscate } = require('../src/index.js');
const { decodeBase64, decodeRc4 } = require('../src/decoders/strings');

const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';
const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const options = { passes: ['decode-string-arrays'], maxIterations: 2 };

// Trusted test-only implementations used to construct fixtures and vectors.
// The source passed to deobfuscate is only parsed; no input decoder is executed.
function base64(value) {
  var alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=', bits = 0, count = 0, out = '';
  for (var n = 0; n < value.length; n++) {
    var digit = alphabet.indexOf(value.charAt(n));
    if (digit === 64) break;
    bits = (bits << 6) | digit;
    count += 6;
    if (count >= 8) { count -= 8; out += String.fromCharCode((bits >>> count) & 255); }
  }
  return decodeURIComponent(out.split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
}

function crypt(value, key) {
  var state = [], j = 0;
  for (var i = 0; i < 256; i++) state[i] = i;
  for (var i = 0; i < 256; i++) {
    j = (j + state[i] + key.charCodeAt(i % key.length)) % 256;
    var tmp = state[i]; state[i] = state[j]; state[j] = tmp;
  }
  var out = '', i = 0; j = 0;
  for (var n = 0; n < value.length; n++) {
    i = (i + 1) % 256; j = (j + state[i]) % 256;
    var tmp = state[i]; state[i] = state[j]; state[j] = tmp;
    out += String.fromCharCode(value.charCodeAt(n) ^ state[(state[i] + state[j]) % 256]);
  }
  return out;
}

function encode(value) {
  return Buffer.from(value, 'utf8').toString('base64').split('').map(character => alphabet[standard.indexOf(character)]).join('');
}

function source(encoded, variant) {
  const rc4Source = crypt.toString().replace(/function crypt\(value, key\) \{/, 'function rc4(value, key) { value = base64(value);');
  return `
    function table() { return [${JSON.stringify(encoded)}]; }
    function decode(index, key) {
      var entries = table();
      var value = entries[index - 16];
      ${base64.toString()}
      ${variant === 'rc4' ? rc4Source : ''}
      value = ${variant === 'rc4' ? 'rc4(value, key)' : 'base64(value)'};
      return value;
    }
    globalThis.result = decode(16, 'abc');
  `;
}

test('custom alphabet base64 vectors include Unicode and whitespace', () => {
  for (const value of ['hello', '智慧树', 'key test']) assert.equal(decodeBase64(encode(value), alphabet), value);
});

test('RC4 vectors include Unicode and whitespace', () => {
  for (const value of ['hello', '智慧树', 'key test']) assert.equal(decodeRc4(encode(crypt(value, 'abc')), 'abc', alphabet, () => {}), value);
});

test('base64 AST decoder is recognized without executing input code', () => {
  const { code, report } = deobfuscate(source(encode('hello'), 'base64'), options);
  assert.match(code, /result\s*=\s*["']hello["']/);
  assert.equal(report.diagnostics.length, 0);
});

test('RC4 AST decoder is recognized without executing input code', () => {
  const { code, report } = deobfuscate(source(encode(crypt('hello', 'abc')), 'rc4'), options);
  assert.match(code, /result\s*=\s*["']hello["']/);
  assert.equal(report.diagnostics.length, 0);
});

test('length bounds preserve calls and diagnose once per decoder', () => {
  const input = `function table(){return [${JSON.stringify('x'.repeat(1025))}]} function decode(i){var a=table();return a[i]} globalThis.result=[decode(0),decode(0)];`;
  const { code, report } = deobfuscate(input, { ...options, maxDecodedStringLength: 1024 });
  assert.match(code, /decode\(0\)/);
  assert.equal(report.diagnostics.filter(item => item.code === 'STRING_DECODER_LENGTH_LIMIT').length, 1);
});
