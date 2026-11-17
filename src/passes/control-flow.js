'use strict';
const { t, traverse, UNKNOWN, evaluate, analyzeDynamicScope, isPublic, initializedBefore, propertyName, isWrite } = require('./_utils');

function splitMayBeModified(ast) {
  let risk = false;
  const stop = path => { risk = true; path.stop(); };
  traverse(ast, {
    Identifier(path) {
      if (path.node.name !== 'String') return;
      if (path.isBindingIdentifier()) { stop(path); return; }
      if (!path.isReferencedIdentifier()) return;
      const parent = path.parentPath;
      if (parent.isUnaryExpression({ operator: 'typeof' })) return;
      if (parent.isCallExpression() && path.key === 'callee') return;
      if (parent.isMemberExpression() && path.key === 'object') return;
      // Passing/aliasing the constructor can let unknown code mutate its prototype.
      stop(path);
    },
    'MemberExpression|OptionalMemberExpression'(path) {
      const name = propertyName(path.node);
      if (name === 'split') {
        const parent = path.parentPath;
        // Ordinary str.split(...) reads do not mutate the intrinsic.
        if (isWrite(path) || !((parent.isCallExpression() || parent.isOptionalCallExpression()) && path.key === 'callee')) stop(path);
      }
      if (name === 'String' && isWrite(path)) stop(path);
      if (name === 'prototype' && (t.isIdentifier(path.node.object, { name: 'String' }) || t.isMemberExpression(path.node.object) && propertyName(path.node.object) === 'String')) {
        if (!(path.parentPath.isMemberExpression() && path.key === 'object')) stop(path);
      }
    },
  });
  return risk;
}

function orderTokens(node) {
  if (t.isArrayExpression(node) && node.elements.every(item => t.isStringLiteral(item))) return node.elements.map(item => item.value);
  if (!t.isCallExpression(node) || node.arguments.length !== 1 || !t.isStringLiteral(node.arguments[0], { value: '|' })) return null;
  const member = node.callee;
  if (!t.isMemberExpression(member) || member.computed || !t.isStringLiteral(member.object) || !t.isIdentifier(member.property, { name: 'split' })) return null;
  return member.object.value.split('|');
}

function forbidden(node) {
  let found = false;
  t.traverseFast(node, value => {
    if (t.isFunction(value) || t.isClass(value) || t.isVariableDeclaration(value) && value.kind !== 'var' || t.isBreakStatement(value) || t.isContinueStatement(value) || t.isReturnStatement(value) || t.isThrowStatement(value) || t.isTryStatement(value) || t.isLabeledStatement(value) || t.isAwaitExpression(value) || t.isYieldExpression(value)) found = true;
  });
  return found;
}

module.exports = {
  name: 'control-flow',
  description: 'Flatten private canonical split-order while/switch dispatchers with fully verified uses and cases.',
  run(ast, context) {
    const dynamic = analyzeDynamicScope(ast, { context });
    const splitRisk = splitMayBeModified(ast);
    let count = 0;
    traverse(ast, { WhileStatement: { exit(path) {
      const truth = evaluate(path.node.test);
      if (truth === UNKNOWN || !truth || path.parentPath.isLabeledStatement() || !t.isBlockStatement(path.node.body)) return;
      const body = path.get('body.body');
      if (body.length !== 2 || !body[0].isSwitchStatement() || !body[1].isBreakStatement() || body[1].node.label) return;
      const dispatcher = body[0];
      const discriminant = dispatcher.get('discriminant');
      if (!discriminant.isMemberExpression() || !discriminant.node.computed || !t.isIdentifier(discriminant.node.object)) return;
      const update = discriminant.get('property');
      if (!update.isUpdateExpression({ operator: '++', prefix: false }) || !t.isIdentifier(update.node.argument)) return;
      const order = path.scope.getBinding(discriminant.node.object.name);
      const index = path.scope.getBinding(update.node.argument.name);
      if (!order || !index || isPublic(order) || isPublic(index) || !order.path.isVariableDeclarator() || !index.path.isVariableDeclarator()) return;
      if (dynamic.affectsBinding(order) || dynamic.affectsBinding(index) || dynamic.affectsRegion(path)) return;
      // Babel records a var initializer inside an enclosing loop as a write to
      // itself. Each execution still dominates this private dispatcher.
      if (order.constantViolations.some(write => write.node !== order.path.node) || !initializedBefore(order.path, path) || !initializedBefore(index.path, path)) return;
      const indexWrites = index.constantViolations.filter(write => write.node !== index.path.node);
      if (evaluate(index.path.node.init) !== 0 || indexWrites.length !== 1 || indexWrites[0].node !== update.node) return;
      if (order.referencePaths.length !== 1 || order.referencePaths[0].node !== discriminant.node.object || index.referencePaths.length !== 1 || index.referencePaths[0].node !== update.node.argument) return;
      const tokens = orderTokens(order.path.node.init);
      if (!tokens || !tokens.length || tokens.length > 1000) return;
      if (t.isCallExpression(order.path.node.init) && splitRisk) {
        if (context && context.warn) context.warn('CONTROL_FLOW_SPLIT_MUTATION', 'control-flow: retained a dispatcher because String/split may be modified or escaped.');
        return;
      }
      const cases = new Map();
      for (const branch of dispatcher.node.cases) {
        if (!t.isStringLiteral(branch.test) || cases.has(branch.test.value) || !branch.consequent.length) return;
        const statements = branch.consequent.slice();
        const terminal = statements.pop();
        const leavesFunction = t.isReturnStatement(terminal) || t.isThrowStatement(terminal);
        if (!(t.isContinueStatement(terminal) || t.isBreakStatement(terminal) || leavesFunction) || terminal.label || statements.some(forbidden)) return;
        if (leavesFunction) statements.push(terminal);
        cases.set(branch.test.value, { statements, stop: !t.isContinueStatement(terminal) });
      }
      if (tokens.some(token => !cases.has(token))) return;
      // A discarded case might still hoist var names used elsewhere. Requiring
      // every case in the order keeps those declarations in the flattened body.
      if (new Set(tokens).size !== cases.size) return;
      const flattened = [];
      // Even cases never visited by an early return/break contribute var bindings.
      const hoisted = new Set();
      for (const branch of cases.values()) for (const statement of branch.statements) t.traverseFast(statement, node => {
        if (t.isVariableDeclaration(node, { kind: 'var' })) for (const declaration of node.declarations) {
          for (const name of Object.keys(t.getBindingIdentifiers(declaration.id))) hoisted.add(name);
        }
      });
      for (let i = 0; i < tokens.length; i++) {
        const branch = cases.get(tokens[i]);
        flattened.push(...branch.statements.map(statement => t.cloneNode(statement, true)));
        if (branch.stop) {
          break;
        }
      }
      const declared = new Set();
      for (const statement of flattened) t.traverseFast(statement, node => {
        if (t.isVariableDeclaration(node, { kind: 'var' })) for (const declaration of node.declarations) {
          for (const name of Object.keys(t.getBindingIdentifiers(declaration.id))) declared.add(name);
        }
      });
      const missing = [...hoisted].filter(name => !declared.has(name));
      if (missing.length) flattened.unshift(t.variableDeclaration('var', missing.map(name => t.variableDeclarator(t.identifier(name)))));
      // Keep both initializers in place, including the original split call, so
      // initializer ordering and any observable effects remain untouched.
      path.replaceWith(t.blockStatement(flattened));
      if (context && context.options && context.options.profile === 'readable') {
        // The private order/index have no uses outside this verified dispatcher.
        for (const declaration of [index.path, order.path]) {
          if (declaration.removed || !declaration.parentPath || !declaration.parentPath.isVariableDeclaration()) continue;
          if (declaration.parentPath.node.declarations.length === 1) declaration.parentPath.remove();
          else declaration.remove();
        }
      }
      count++;
    } } });
    return count;
  },
};
