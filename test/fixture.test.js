'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const types = require('@babel/types');
const { deobfuscate } = require('../src/index.js');

test('real website snapshot has recorded provenance and unchanged bytes', () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/zhihuishu-2.metadata.json'), 'utf8'));
  const source = fs.readFileSync(path.join(__dirname, 'fixtures', metadata.filename));
  assert.equal(source.length, metadata.bytes);
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), metadata.sha256);
  assert.equal(metadata.sourceUrl, 'https://base2.zhihuishu.com/js/2.js');
});

test('real website snapshot is transformed and reparsed without execution', { timeout: 120000 }, () => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/zhihuishu-2.obfuscated.js'), 'utf8');
  const inputAst = parser.parse(source, { sourceType: 'unambiguous' });
  assert.ok(inputAst.program.body.length > 0);
  const { code, report } = deobfuscate(source, {
    filename: 'zhihuishu-2.obfuscated.js',
  });
  const outputAst = parser.parse(code, { sourceType: 'unambiguous' });
  assert.ok(outputAst.program.body.length > 0);
  assert.ok(report.passes.length > 0);
  assert.equal(report.input.sha256, 'f3d1f73e586f022d3e0d7f2237a37c09cb9ae5136fb8f1ca3b4111221fc3ccfe');
  assert.match(code, /JSEncrypt/);
  assert.ok(report.passes.filter((pass) => pass.name === 'decode-string-arrays')
    .reduce((sum, pass) => sum + pass.changes, 0) >= 1200);
  assert.equal(report.converged, true);
  assert.ok(code.includes('https://appcomm-user.zhihuishu.com/app-commserv-user/c/hasV2'));
  assert.match(code, /aesUtil\.encrypt/);
});

test('readable website snapshot removes decoder scaffolding and resolves known business branches', { timeout: 120000 }, () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/zhihuishu-2.baseline.json'), 'utf8'));
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/zhihuishu-2.obfuscated.js'), 'utf8');
  const { code, report } = deobfuscate(source, {
    filename: 'zhihuishu-2.obfuscated.js', profile: 'readable',
  });
  const ast = parser.parse(code, { sourceType: 'unambiguous' });
  assert.equal(report.profile, 'readable');
  assert.equal(report.input.sha256, 'f3d1f73e586f022d3e0d7f2237a37c09cb9ae5136fb8f1ca3b4111221fc3ccfe');
  assert.equal(baseline.inputSha256, report.input.sha256, 'Before/after metrics must refer to the same input snapshot');
  assert.equal(report.converged, true);
  assert.equal(report.residuals.before.dispatcherLoops, baseline.metrics.dispatcherLoops);
  assert.equal(report.residuals.after.dispatcherLoops, 0);
  assert.equal(report.residuals.after.sourceSelfDefensePatterns, 0);
  assert.ok(report.residuals.after.obfuscatedAliasDeclarations < baseline.metrics.obfuscatedAliasDeclarations);
  assert.ok(report.residuals.after.sequenceExpressions < baseline.metrics.sequenceExpressions);
  assert.ok(report.residuals.after.obfuscatedBindings < baseline.metrics.obfuscatedBindings);
  // The measured result is 4 candidates versus 309 in the saved baseline.
  // A generous 90% reduction guard catches a disabled dispatch pass without
  // freezing an exact count of legitimate short arithmetic library helpers.
  assert.ok(report.residuals.after.proxyFunctionCandidates <= Math.floor(baseline.metrics.proxyFunctionCandidates / 10),
    'Proxy-function candidates should remain substantially below the previous output');

  const decoderFamily = new Set(['a0_0x5e57', 'a0_0x1329', 'a0_0x2e28aa']);
  let familyIdentifiers = 0;
  let labcPath;
  let yxyzPath;
  traverse(ast, {
    Identifier(path) { if (decoderFamily.has(path.node.name)) familyIdentifiers++; },
    FunctionDeclaration(path) {
      if (path.node.id.name === 'labc') labcPath = path;
      if (path.node.id.name === 'yxyz') yxyzPath = path;
    },
  });
  assert.equal(familyIdentifiers, 0, 'The decoded helper family should have no remaining references or declarations');
  assert.ok(report.diagnostics.some((item) => item.code === 'READABLE_DECODER_SCAFFOLD_REMOVED'));
  assert.ok(labcPath && yxyzPath, 'Public business functions must remain available');

  let ajaxOptions;
  let resolveName;
  let rejectName;
  labcPath.traverse({
    ReferencedIdentifier(path) {
      assert.notEqual(path.node.name, '_0x26c948', 'The provably false error callback branch must be removed');
    },
    CallExpression(path) {
      const callee = path.node.callee;
      if (callee.type === 'MemberExpression' && callee.object.name === '$' && callee.property.name === 'ajax') {
        ajaxOptions = path.node.arguments[0];
      }
    },
    NewExpression(path) {
      if (path.node.callee.type === 'Identifier' && path.node.callee.name === 'Promise') {
        const executor = path.node.arguments[0];
        resolveName = executor.params[0].name;
        rejectName = executor.params[1].name;
      }
    },
  });
  assert.ok(ajaxOptions, 'The labc AJAX request must remain');
  assert.equal(ajaxOptions.type, 'ObjectExpression');
  const properties = new Map(ajaxOptions.properties.map((property) => [property.key.name || property.key.value, property.value]));
  assert.equal(properties.get('type').value, 'get');
  assert.equal(properties.get('dataType').value, 'json');
  const errorCallback = properties.get('error');
  assert.equal(errorCallback.type, 'FunctionExpression');
  let directRejections = 0;
  types.traverseFast(errorCallback.body, (node) => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === rejectName) directRejections++;
  });
  assert.equal(directRejections, 1, 'The error callback should call its rejection parameter directly');
  let directResolutions = 0;
  types.traverseFast(properties.get('success').body, (node) => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === resolveName) directResolutions++;
  });
  assert.equal(directResolutions, 1, 'The success callback should call its resolution parameter directly');

  const finalStatement = yxyzPath.node.body.body.at(-1);
  assert.equal(finalStatement.type, 'ReturnStatement');
  assert.equal(finalStatement.argument.type, 'CallExpression');
  assert.equal(finalStatement.argument.callee.object.name, 'aesUtil');
  assert.equal(finalStatement.argument.callee.property.name, 'encrypt');
  assert.ok(code.includes('https://appcomm-user.zhihuishu.com/app-commserv-user/c/hasV2'));
  assert.match(code, /window\.JSEncrypt/);
});

test('optional class reconstruction groups the real JSEncrypt API and recognized RSA inheritance', { timeout: 120000 }, () => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/zhihuishu-2.obfuscated.js'), 'utf8');
  const { code, map, report } = deobfuscate(source, {
    filename: 'zhihuishu-2.obfuscated.js', profile: 'readable', modernize: 'class', sourceMaps: true,
  });
  const ast = parser.parse(code, { sourceType: 'unambiguous' });
  const classes = new Map();
  const functions = new Set();
  let prototypeAssignments = 0;
  traverse(ast, {
    ClassDeclaration(path) { if (path.node.id) classes.set(path.node.id.name, path.node); },
    FunctionDeclaration(path) { if (path.node.id) functions.add(path.node.id.name); },
    AssignmentExpression(path) {
      const left = path.node.left;
      if (types.isMemberExpression(left) && types.isMemberExpression(left.object) &&
          !left.object.computed && types.isIdentifier(left.object.property, { name: 'prototype' }) &&
          types.isFunctionExpression(path.node.right)) prototypeAssignments++;
    },
  });
  assert.equal(report.input.sha256, 'f3d1f73e586f022d3e0d7f2237a37c09cb9ae5136fb8f1ca3b4111221fc3ccfe');
  assert.equal(report.modernization.mode, 'class');
  assert.equal(report.modernization.tool.name, 'lebab');
  assert.equal(report.modernization.tool.version, '3.2.9');
  assert.ok(report.modernization.classesConverted > 0);
  assert.ok(report.modernization.prototypeMethodsConverted > 0);
  assert.ok(prototypeAssignments < 155, 'The class stage must reduce scattered prototype functions');
  assert.ok(classes.has('pt'), 'The public JSEncrypt implementation must be grouped as a class');
  const methods = new Set(classes.get('pt').body.body.map(member => member.key.name || member.key.value));
  for (const name of ['constructor', 'setKey', 'setPrivateKey', 'setPublicKey', 'encrypt', 'decrypt',
    'sign', 'verify', 'getKey', 'getPrivateKey', 'getPrivateKeyB64', 'getPublicKey', 'getPublicKeyB64']) {
    assert.ok(methods.has(name), `JSEncrypt class is missing ${name}`);
  }
  for (const name of ['nt', 'lt', 'O', 'x', 'I', 'P', 'q', 'L']) {
    assert.ok(classes.has(name), `Recognized constructor ${name} must be grouped as a class`);
    assert.ok(!functions.has(name));
  }
  assert.equal(classes.get('lt').superClass.name, 'nt');
  assert.doesNotMatch(code, /at\.call\(this\)/);
  assert.ok(prototypeAssignments <= 3, 'Only the three environment-selected am implementations may remain');
  assert.match(code, /window\.JSEncrypt/);
  assert.match(code, /aesUtil\.encrypt/);
  assert.ok(code.includes('https://appcomm-user.zhihuishu.com/app-commserv-user/c/hasV2'));
  assert.ok(map.sourcesContent.includes(source));
  assert.equal(report.output.sha256, crypto.createHash('sha256').update(code).digest('hex'));
  assert.ok(report.diagnostics.some(item => item.code.startsWith('CLASS_')));
});
