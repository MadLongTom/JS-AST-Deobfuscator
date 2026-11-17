'use strict';

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;

const obfuscated = name => /^(?:_0x[\da-f]+|a\d*_0x[\da-f]+)$/i.test(name);

function proxyCandidate(node) {
  if (!t.isFunction(node) || node.async || node.generator || !node.params.every(parameter => t.isIdentifier(parameter))) return false;
  const parameters = new Set(node.params.map(parameter => parameter.name));
  let body = node.body;
  if (t.isBlockStatement(body)) {
    const statements = body.body.filter(statement => !t.isVariableDeclaration(statement) || !statement.declarations.every(item => t.isIdentifier(item.id) && t.isIdentifier(item.init)));
    if (statements.length !== 1 || !t.isReturnStatement(statements[0])) return false;
    body = statements[0].argument;
  }
  if (!body || !(t.isBinaryExpression(body) || t.isUnaryExpression(body) || t.isLogicalExpression(body) || t.isCallExpression(body))) return false;
  let valid = true;
  t.traverseFast(body, node => {
    if (t.isIdentifier(node) && !parameters.has(node.name)) valid = false;
    if (t.isMemberExpression(node) || t.isThisExpression(node) || t.isFunction(node) || t.isAssignmentExpression(node) || t.isUpdateExpression(node)) valid = false;
  });
  return valid;
}

/** Structural indicators, not a proof or percentage of completed deobfuscation. */
function analyzeAst(ast) {
  const result = {
    nodes: 0,
    obfuscatedBindings: 0,
    obfuscatedAliasDeclarations: 0,
    dispatcherLoops: 0,
    proxyFunctionCandidates: 0,
    sequenceExpressions: 0,
    conditionalExpressions: 0,
    sourceSelfDefensePatterns: 0,
  };
  const scopes = new Set();
  traverse(ast, {
    enter(path) {
      result.nodes++;
      if (!scopes.has(path.scope)) {
        scopes.add(path.scope);
        for (const name of Object.keys(path.scope.bindings)) if (obfuscated(name)) result.obfuscatedBindings++;
      }
    },
    VariableDeclarator(path) {
      if (t.isIdentifier(path.node.id) && t.isIdentifier(path.node.init) && (obfuscated(path.node.id.name) || obfuscated(path.node.init.name))) result.obfuscatedAliasDeclarations++;
    },
    WhileStatement(path) {
      if (!t.isBlockStatement(path.node.body)) return;
      if (path.node.body.body.some(statement => t.isSwitchStatement(statement) && t.isMemberExpression(statement.discriminant) && statement.discriminant.computed && t.isUpdateExpression(statement.discriminant.property))) result.dispatcherLoops++;
    },
    Function(path) { if (proxyCandidate(path.node)) result.proxyFunctionCandidates++; },
    SequenceExpression() { result.sequenceExpressions++; },
    ConditionalExpression() { result.conditionalExpressions++; },
    StringLiteral(path) {
      // Known javascript-obfuscator source-text self-check signatures only.
      if (path.node.value.includes('(((.+)+)+)+$') || path.node.value.includes('\\w+ *\\(\\) *{\\w+ *')) result.sourceSelfDefensePatterns++;
    },
  });
  return result;
}

module.exports = { analyzeAst };
