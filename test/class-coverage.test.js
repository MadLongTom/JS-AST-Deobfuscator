'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const types = require('@babel/types');
const { deobfuscate } = require('../src/index.js');

const property = node => node.computed ? types.isStringLiteral(node.property) ? node.property.value : null : node.property.name;

test('real class coverage includes the BigInteger, reducers and RSA families without executing the sample', { timeout: 120000 }, () => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/zhihuishu-2.obfuscated.js'), 'utf8');
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/zhihuishu-2.classes-baseline.json'), 'utf8'));
  const { code, map, report } = deobfuscate(source, {
    filename: 'zhihuishu-2.obfuscated.js', profile: 'readable', modernize: 'class', sourceMaps: true,
  });
  assert.equal(report.input.sha256, baseline.inputSha256);
  assert.ok(map.sourcesContent.includes(source));
  const ast = parser.parse(code);
  const classes = new Map();
  const scattered = new Map();
  let totalOutsideDirect = 0;
  traverse(ast, {
    Class(path) { if (path.node.id) classes.set(path.node.id.name, path.node); },
    AssignmentExpression(path) {
      const node = path.node;
      if (node.operator !== '=' || !types.isFunctionExpression(node.right) || !types.isMemberExpression(node.left)
        || !types.isMemberExpression(node.left.object) || property(node.left.object) !== 'prototype') return;
      if (path.findParent(parent => parent.isClass())) return;
      let conditional = false;
      for (let parent = path.parentPath; parent && !parent.isFunction(); parent = parent.parentPath) {
        if (parent.isIfStatement() || parent.isConditionalExpression() || parent.isLogicalExpression() || parent.isSwitchCase() || parent.isLoop()) conditional = true;
      }
      if (!conditional) {
        totalOutsideDirect++;
        const owner = node.left.object.object;
        const family = types.isIdentifier(owner) ? owner.name : '(dynamic owner)';
        scattered.set(family, (scattered.get(family) || 0) + 1);
      }
    },
  });
  const required = ['x', 'I', 'P', 'q', 'L', 'O', 'nt', 'lt', 'pt'];
  for (const name of required) {
    assert.ok(classes.has(name), `Expected the ${name} constructor family to become a class`);
    assert.ok(report.modernization.converted.some(item => item.name === name), `Expected a conversion record for ${name}`);
    assert.equal(scattered.get(name) || 0, 0, `${name} methods should no longer be scattered outside its class`);
  }
  assert.equal(classes.get('lt').superClass.type, 'Identifier');
  assert.equal(classes.get('lt').superClass.name, 'nt');

  const bigint = classes.get('O');
  const bigintMethods = new Set(bigint.body.body.filter(node => types.isClassMethod(node)).map(node => node.key.name || node.key.value));
  for (const name of ['toString', 'fromString', 'multiply', 'modPow', 'gcda', 'fromNumberAsync']) {
    assert.ok(bigintMethods.has(name), `BigInteger class should retain ${name}`);
  }
  let navigatorSelections = 0;
  let conditionalAmInstallations = 0;
  const bigintRecord = report.modernization.converted.find(item => item.name === 'O');
  assert.equal(bigintRecord.runtimeInstallationsRetained, 3);
  const bigintAliases = new Set(['O', ...bigintRecord.aliases]);
  const runtimeStatements = new Set();
  const dataFields = new Set();
  traverse(ast, {
    AssignmentExpression(path) {
      const node = path.node;
      if (!types.isMemberExpression(node.left) || !types.isMemberExpression(node.left.object)
        || property(node.left.object) !== 'prototype' || !types.isIdentifier(node.left.object.object)
        || !bigintAliases.has(node.left.object.object.name)) return;
      const name = property(node.left);
      if (name === 'am' && types.isFunctionExpression(node.right)) {
        conditionalAmInstallations++;
        assert.equal(!!path.findParent(parent => parent.isClass()), false, 'Runtime-selected am installation must retain its original initialization phase');
        assert.ok(node.start > bigint.end);
        const statement = path.findParent(parent => parent.isExpressionStatement() || parent.isVariableDeclaration());
        runtimeStatements.add(statement.node);
      } else if (['DB', 'DM', 'DV', 'FV', 'F1', 'F2'].includes(name)) {
        dataFields.add(name);
        assert.equal(!!path.findParent(parent => parent.isClass()), false, 'Shared prototype data must not be moved into an earlier class initializer');
        assert.ok(node.start > bigint.end);
      }
    },
  });
  for (const statement of runtimeStatements) types.traverseFast(statement, node => {
    if (types.isMemberExpression(node) && types.isIdentifier(node.object, { name: 'navigator' }) && property(node) === 'appName') navigatorSelections++;
  });
  assert.ok(navigatorSelections >= 2, 'BigInteger must preserve the runtime browser selection rather than choosing the analysis host');
  assert.equal(conditionalAmInstallations, 3, 'All three environment-selected am implementations must remain');
  assert.equal(dataFields.size, 6, 'All six shared prototype data fields must remain');

  // The readable sample contains 152 unconditional prototype function installs;
  // the previous class release still had 114 function-assignment nodes overall.
  // Keep a margin while requiring that more than 95% are now co-located as classes.
  assert.ok(totalOutsideDirect <= 7, `Too many scattered direct prototype methods remain: ${totalOutsideDirect}`);
  for (const [name, count] of scattered) {
    if (count > 2) assert.ok(report.modernization.skipped.some(item => item.name === name && item.reason),
      `A remaining method-installation cluster for ${name} needs an explicit skip reason`);
  }
  assert.ok(report.modernization.prototypeMethodsConverted > baseline.prototypeMethodsConverted);
  assert.match(code, /Object\.prototype/);
  assert.match(code, /this\.init\.prototype/);
});
