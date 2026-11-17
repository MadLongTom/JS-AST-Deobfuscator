'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { deobfuscate } = require('../src');
const { indexWebpackModules, webpackModuleExcerpts } = require('../src/readability/webpack');

test('the recorded Yidun fixture is decoded in layers and indexed without execution', { timeout: 120000 }, () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/netease-core-2.28.5.metadata.json'), 'utf8'));
  const source = fs.readFileSync(path.join(__dirname, 'fixtures', metadata.filename), 'utf8');
  assert.equal(Buffer.byteLength(source), metadata.bytes);
  assert.equal(createHash('sha256').update(source).digest('hex'), metadata.sha256);
  const result = deobfuscate(source, {
    filename: metadata.filename,
    profile: 'readable',
    renameBindings: true,
    maxIterations: 50,
    sourceMaps: true,
  });
  const { code, report } = result;
  const ast = parser.parse(code);
  assert.equal(report.converged, true);
  const count = name => report.passes.filter(pass => pass.name === name).reduce((sum, pass) => sum + pass.changes, 0);
  assert.ok(count('decode-string-arrays') >= 4500, 'The outer custom-alphabet string table must decode.');
  assert.ok(count('decode-substituted-hex') >= 2000, 'The nested substitution table and primitive array indices must decode.');
  assert.ok(report.readability.bindingsRenamed > 2500);
  assert.equal(report.readability.webpackFactories, 77);
  assert.ok(report.residuals.after.sequenceExpressions < report.residuals.before.sequenceExpressions / 2);
  assert.ok(report.diagnostics.some(item => item.code === 'READABLE_DECODER_SCAFFOLD_REMOVED'));
  assert.ok(report.diagnostics.some(item => item.code === 'READABLE_HEX_SCAFFOLD_REMOVED'));
  assert.ok(!report.diagnostics.some(item => item.code === 'UNSUPPORTED_DYNAMIC_SCOPE'));
  assert.ok(code.includes('onVerify') && code.includes('/check') && code.includes('NECaptcha'));
  let decoderCalls = 0;
  let evalCalls = 0;
  traverse(ast, { CallExpression(path) {
    if (path.get('callee').isIdentifier({ name: 'a0_0x1e60' })) decoderCalls++;
    if (path.get('callee').isIdentifier({ name: 'eval' })) evalCalls++;
  } });
  assert.equal(decoderCalls, 0);
  assert.equal(evalCalls, 1, 'The JSON compatibility parser remains intact; source was not evaluated.');
  const bundles = indexWebpackModules(ast);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].modules.length, 77);
  assert.equal(webpackModuleExcerpts(ast).length, 77);
  assert.ok(result.map.sources.includes(metadata.filename));
  assert.equal(result.map.sourcesContent[0], source);
});
