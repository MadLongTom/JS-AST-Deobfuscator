'use strict';
const t = require('@babel/types');

function within(path, ancestor) {
  for (let current = path; current; current = current.parentPath) if (current === ancestor) return true;
  return false;
}

function bindingForFunction(path) {
  if (path.isVariableDeclarator() && t.isIdentifier(path.node.id)) return path.scope.getBinding(path.node.id.name);
  if (path.isFunctionDeclaration() && path.node.id) return path.parentPath.scope.getBinding(path.node.id.name);
  if (path.parentPath.isVariableDeclarator() && t.isIdentifier(path.parentPath.node.id)) return path.parentPath.scope.getBinding(path.parentPath.node.id.name);
  return null;
}

function memberName(node) {
  if (!t.isMemberExpression(node)) return null;
  if (!node.computed && t.isIdentifier(node.property)) return node.property.name;
  return t.isStringLiteral(node.property) ? node.property.value : null;
}

function removeDeclaration(path) {
  if (!path || !path.node || path.removed) return false;
  if (path.isFunction() && path.parentPath.isVariableDeclarator()) path = path.parentPath;
  if (path.isVariableDeclarator()) {
    if (path.parentPath.node.declarations.length === 1) path.parentPath.remove();
    else path.remove();
  } else if (path.isFunctionDeclaration()) path.remove();
  else return false;
  return true;
}

function removeExpression(path) {
  if (!path || !path.node || path.removed) return false;
  if (path.parentPath.isExpressionStatement()) { path.parentPath.remove(); return true; }
  if (path.parentPath.isSequenceExpression()) {
    const sequence = path.parentPath;
    if (!sequence.parentPath.isExpressionStatement()) return false;
    const remaining = sequence.node.expressions.filter(expression => expression !== path.node);
    if (!remaining.length) sequence.parentPath.remove();
    else if (remaining.length === 1) sequence.replaceWith(remaining[0]);
    else sequence.node.expressions = remaining;
    return true;
  }
  if (path.parentPath.isUnaryExpression({ operator: '!' }) || path.parentPath.isUnaryExpression({ operator: 'void' })) return removeExpression(path.parentPath);
  return false;
}

module.exports = { within, bindingForFunction, memberName, removeDeclaration, removeExpression };
