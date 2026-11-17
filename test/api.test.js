'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const parser = require('@babel/parser');
const { deobfuscate, listPasses } = require('../src/index.js');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('a rejected asynchronous plugin is reported without leaking a rejection', async () => {
  assert.throws(() => deobfuscate('1;', {
    passes: ['async-plugin'],
    customPasses: [{ name: 'async-plugin', run() { return Promise.reject(new Error('async failure')); } }],
  }), error => error.code === 'PASS_ERROR' && error.passName === 'async-plugin');
  await new Promise(resolve => setImmediate(resolve));
});

test('listPasses exposes unique names and descriptions', () => {
  const passes = listPasses();
  assert.ok(Array.isArray(passes) && passes.length > 0);
  assert.equal(new Set(passes.map((pass) => pass.name)).size, passes.length);
  for (const pass of passes) {
    assert.equal(typeof pass.name, 'string');
    assert.ok(typeof pass.description === 'string' && pass.description.length > 0);
  }
});

test('reports are JSON serializable and hash exact input and output bytes', () => {
  const source = 'globalThis.result = "中文" + (1 + 2);';
  const { code, map, report } = deobfuscate(source, { filename: 'example.js' });
  parser.parse(code);
  assert.ok(map == null);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.input.filename, 'example.js');
  assert.equal(report.input.bytes, Buffer.byteLength(source));
  assert.equal(report.input.sha256, sha256(source));
  assert.equal(report.output.bytes, Buffer.byteLength(code));
  assert.equal(report.output.sha256, sha256(code));
  assert.ok(Number.isInteger(report.iterations) && report.iterations >= 1);
  assert.equal(typeof report.converged, 'boolean');
  assert.ok(Array.isArray(report.passes));
  assert.ok(Array.isArray(report.diagnostics));
  for (const pass of report.passes) {
    assert.ok(Number.isInteger(pass.changes) && pass.changes >= 0);
    assert.ok(Number.isInteger(pass.iteration) && pass.iteration >= 1);
    assert.ok(Number.isFinite(pass.durationMs) && pass.durationMs >= 0);
  }
  assert.equal(report.totals.changes, report.passes.reduce((sum, pass) => sum + pass.changes, 0));
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test('source maps identify the supplied source file', () => {
  const source = 'globalThis.result = 1 + 2;';
  const { map } = deobfuscate(source, { sourceMaps: true, filename: 'source.js' });
  assert.equal(map.version, 3);
  assert.ok(map.sources.includes('source.js'));
  assert.ok(map.sourcesContent.includes(source));
});

test('passes are selected and reported in the requested order', () => {
  const { code, report } = deobfuscate('globalThis.result = 0x10 + 2;', {
    passes: ['constant-fold', 'normalize-literals'], maxIterations: 1,
  });
  assert.deepEqual(report.passes.map((pass) => pass.name), ['constant-fold', 'normalize-literals']);
  assert.match(code, /18/);
});

test('empty pass list only parses and prints', () => {
  const { code, report } = deobfuscate('globalThis.result = 1 + 2;', { passes: [] });
  assert.match(code, /1\s*\+\s*2/);
  assert.deepEqual(report.passes, []);
  assert.equal(report.totals.changes, 0);
});

test('ES module exports remain valid and public', () => {
  const { code } = deobfuscate('export const value = 1 + 2; export function read() { return value; }', {
    sourceType: 'module',
  });
  const ast = parser.parse(code, { sourceType: 'module' });
  assert.ok(ast.program.body.some((node) => node.type === 'ExportNamedDeclaration'));
  assert.match(code, /export/);
  assert.match(code, /\bvalue\b/);
  assert.match(code, /\bread\b/);
});

test('parse failures have a stable error code and location', () => {
  assert.throws(() => deobfuscate('const = ;'), (error) => {
    assert.equal(error.code, 'PARSE_ERROR');
    assert.ok(error.location);
    return true;
  });
});

for (const [name, options] of [
  ['unknown pass', { passes: ['does-not-exist'] }],
  ['string rather than array of passes', { passes: 'constant-fold' }],
  ['zero iterations', { maxIterations: 0 }],
  ['fractional iterations', { maxIterations: 1.5 }],
  ['too many iterations', { maxIterations: 51 }],
  ['invalid source type', { sourceType: 'anything' }],
  ['boolean modernization request', { modernize: true }],
  ['unknown modernization mode', { modernize: 'all' }],
  ['null modernization mode', { modernize: null }],
  ['unknown option', { madeUpOption: true }],
  ['duplicate selected pass', { passes: ['constant-fold', 'constant-fold'] }],
  ['nonboolean source maps', { sourceMaps: 'yes' }],
  ['empty filename', { filename: '' }],
  ['invalid parser plugins', { plugins: [false] }],
  ['null custom pass list', { customPasses: null }],
  ['null custom pass', { customPasses: [null] }],
  ['invalid custom pass name', { customPasses: [{ name: 'BadName', run() { return 0; } }] }],
  ['missing custom pass runner', { customPasses: [{ name: 'missing-runner' }] }],
  ['duplicate registered pass', { customPasses: [{ name: 'constant-fold', run() { return 0; } }] }],
  ['operation bound too small', { maxDecoderOperations: 999 }],
  ['operation bound too large', { maxDecoderOperations: 10000001 }],
  ['fractional operation bound', { maxDecoderOperations: 1000.5 }],
  ['zero rotation bound', { maxStringArrayRotations: 0 }],
  ['rotation bound too large', { maxStringArrayRotations: 100001 }],
  ['decoded length bound too small', { maxDecodedStringLength: 1023 }],
  ['decoded length bound too large', { maxDecodedStringLength: 1000001 }],
]) {
  test(`rejects invalid options: ${name}`, () => {
    assert.throws(() => deobfuscate('1;', options), (error) => error.code === 'INVALID_OPTIONS');
  });
}

test('caller-owned options and pass arrays remain unchanged', () => {
  const options = { passes: ['constant-fold'], maxIterations: 2, plugins: ['jsx'] };
  const snapshot = JSON.stringify(options);
  deobfuscate('globalThis.result = 1 + 2;', options);
  assert.equal(JSON.stringify(options), snapshot);
});

test('null options and nonstring sources are rejected with INVALID_OPTIONS', () => {
  for (const call of [() => deobfuscate('1;', null), () => deobfuscate(null), () => deobfuscate(Buffer.from('1;'))]) {
    assert.throws(call, (error) => error.code === 'INVALID_OPTIONS');
  }
});

test('transformation never executes input side effects', () => {
  const key = '__DEOBFUSCATOR_INPUT_EXECUTED__';
  delete globalThis[key];
  try {
    deobfuscate('globalThis.__DEOBFUSCATOR_INPUT_EXECUTED__ = true; (function () { throw new Error("must not run"); })();');
    assert.equal(globalThis[key], undefined);
  } finally {
    delete globalThis[key];
  }
});

test('a custom pass throwing a non-Error value still produces PASS_ERROR', () => {
  for (const thrown of [null, undefined, 'deliberate string error']) {
    assert.throws(() => deobfuscate('1;', {
      passes: ['non-error-throw'],
      customPasses: [{ name: 'non-error-throw', run() { throw thrown; } }],
    }), (error) => error.name === 'DeobfuscationError' && error.code === 'PASS_ERROR' && error.passName === 'non-error-throw');
  }
});

test('a malformed AST from a custom pass produces PASS_ERROR during generation', () => {
  assert.throws(() => deobfuscate('1;', {
    passes: ['bad-ast'],
    customPasses: [{
      name: 'bad-ast',
      run(ast) { ast.program.body[0] = { type: 'NotARealNode' }; return 1; },
    }],
  }), (error) => error.name === 'DeobfuscationError' && error.code === 'PASS_ERROR' && error.passName === 'bad-ast');
});
