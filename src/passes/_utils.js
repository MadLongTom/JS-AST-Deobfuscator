'use strict';

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { analyzeDynamicScope } = require('./_dynamic-scope');
const UNKNOWN = Symbol('unknown');
const MAX_STRING = 1024 * 1024;

// Truthiness is known for an allocation without evaluating object coercion.
// Spread, computed keys and effectful element/property initializers are kept.
function safeTruthyAllocation(node, depth = 0) {
  if (!node || depth > 80) return false;
  if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node) || t.isRegExpLiteral(node)) return true;
  const harmless = value => !value || evaluate(value, depth + 1) !== UNKNOWN || safeTruthyAllocation(value, depth + 1);
  if (t.isArrayExpression(node)) return node.elements.every(value => !t.isSpreadElement(value) && harmless(value));
  if (t.isObjectExpression(node)) return node.properties.every(property =>
    !property.computed && (t.isObjectMethod(property) || t.isObjectProperty(property) && harmless(property.value)));
  return false;
}

// Only language operations on primitive literals are interpreted. In particular,
// identifiers, property access, calls and coercions of objects never run here.
function evaluate(node, depth = 0) {
  if (!node || depth > 80) return UNKNOWN;
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return node.value;
  if (t.isNullLiteral(node)) return null;
  if (t.isParenthesizedExpression(node)) return evaluate(node.expression, depth + 1);
  const read = value => evaluate(value, depth + 1);
  try {
    if (t.isUnaryExpression(node)) {
      if (node.operator === '!' && safeTruthyAllocation(node.argument, depth + 1)) return false;
      const value = read(node.argument);
      if (value === UNKNOWN) return UNKNOWN;
      switch (node.operator) {
        case '!': return !value;
        case '~': return ~value;
        case '+': return +value;
        case '-': return -value;
        case 'void': return undefined;
        case 'typeof': return typeof value;
        default: return UNKNOWN;
      }
    }
    if (t.isLogicalExpression(node)) {
      const left = read(node.left);
      if (left === UNKNOWN) return UNKNOWN;
      if (node.operator === '&&') return left ? read(node.right) : left;
      if (node.operator === '||') return left ? left : read(node.right);
      if (node.operator === '??') return left == null ? read(node.right) : left;
      return UNKNOWN;
    }
    if (t.isConditionalExpression(node)) {
      const test = read(node.test);
      return test === UNKNOWN ? UNKNOWN : read(test ? node.consequent : node.alternate);
    }
    if (t.isBinaryExpression(node)) {
      const left = read(node.left), right = read(node.right);
      if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
      let value;
      switch (node.operator) {
        case '+': value = left + right; break;
        case '-': value = left - right; break;
        case '*': value = left * right; break;
        case '/': value = left / right; break;
        case '%': value = left % right; break;
        case '**': value = left ** right; break;
        case '<<': value = left << right; break;
        case '>>': value = left >> right; break;
        case '>>>': value = left >>> right; break;
        case '|': value = left | right; break;
        case '&': value = left & right; break;
        case '^': value = left ^ right; break;
        case '==': value = left == right; break; // Intentional JS primitive semantics.
        case '!=': value = left != right; break;
        case '===': value = left === right; break;
        case '!==': value = left !== right; break;
        case '<': value = left < right; break;
        case '<=': value = left <= right; break;
        case '>': value = left > right; break;
        case '>=': value = left >= right; break;
        default: return UNKNOWN;
      }
      return typeof value === 'string' && value.length > MAX_STRING ? UNKNOWN : value;
    }
    if (t.isTemplateLiteral(node)) {
      let value = node.quasis[0].value.cooked;
      if (value == null) return UNKNOWN;
      for (let i = 0; i < node.expressions.length; i++) {
        const part = read(node.expressions[i]);
        if (part === UNKNOWN || node.quasis[i + 1].value.cooked == null) return UNKNOWN;
        value += String(part) + node.quasis[i + 1].value.cooked;
        if (value.length > MAX_STRING) return UNKNOWN;
      }
      return value;
    }
  } catch (_) {
    // An operation which would throw must remain in the program.
  }
  return UNKNOWN;
}

function literal(value) {
  if (value === undefined) return t.unaryExpression('void', t.numericLiteral(0), true);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return t.binaryExpression('/', t.numericLiteral(0), t.numericLiteral(0));
    if (!Number.isFinite(value)) return t.binaryExpression('/', t.numericLiteral(value < 0 ? -1 : 1), t.numericLiteral(0));
    if (Object.is(value, -0)) return t.unaryExpression('-', t.numericLiteral(0), true);
  }
  return t.valueToNode(value);
}

function programOf(path) {
  return path.isProgram() ? path : path.findParent(parent => parent.isProgram());
}

function dynamicScope(ast, context, pass) {
  // Preserve the legacy whole-AST boolean API. Binding transforms can opt into
  // analyzeDynamicScope and query each binding/site instead of this broad gate.
  const found = analyzeDynamicScope(ast, { context }).hasAny;
  if (found && context && context.warn) context.warn('DYNAMIC_SCOPE', `${pass}: binding transforms skipped because eval or with is present.`);
  return found;
}

function isPublic(binding) {
  if (!binding) return true;
  if (binding.path.findParent(path => path.isExportNamedDeclaration() || path.isExportDefaultDeclaration())) return true;
  const program = programOf(binding.path);
  if (binding.scope.path.isProgram() && (!program || program.node.sourceType !== 'module')) return true;
  return binding.referencePaths.some(ref => ref.findParent(path => path.isExportSpecifier() || path.isExportDefaultDeclaration()));
}

// An initializer must execute before its use, in the same function invocation.
// Requiring an earlier sibling statement deliberately rejects conditional init,
// closures, loop-header init, and same-declaration TDZ edge cases.
function initializedBefore(declaration, reference) {
  if (declaration.getFunctionParent() !== reference.getFunctionParent()) return false;
  const statement = declaration.getStatementParent();
  if (!statement || !statement.inList || !statement.parentPath) return false;
  let child = reference;
  while (child && child.parentPath !== statement.parentPath) child = child.parentPath;
  return !!child && child.inList && child.listKey === statement.listKey && child.key > statement.key;
}

function isWrite(member) {
  let current = member;
  while (current.parentPath && (current.parentPath.isObjectProperty() || current.parentPath.isObjectPattern() || current.parentPath.isArrayPattern() || current.parentPath.isRestElement() || current.parentPath.isAssignmentPattern())) current = current.parentPath;
  const parent = current.parentPath;
  return !!parent && (
    parent.isAssignmentExpression() && current.key === 'left' ||
    parent.isUpdateExpression() ||
    parent.isUnaryExpression({ operator: 'delete' }) ||
    (parent.isForInStatement() || parent.isForOfStatement()) && current.key === 'left'
  );
}

function propertyName(node) {
  if (!node.computed && t.isIdentifier(node.property)) return node.property.name;
  if (t.isStringLiteral(node.property) || t.isNumericLiteral(node.property)) return String(node.property.value);
  return null;
}

// A wrapper body may only depend on its parameters. No this, arguments,
// captured names, property reads, calls, mutation, defaults, or nested closures.
function wrapperExpression(node) {
  if (!(t.isFunctionDeclaration(node) || t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) || node.async || node.generator) return null;
  if (!node.params.every(param => t.isIdentifier(param))) return null;
  const names = node.params.map(param => param.name);
  if (new Set(names).size !== names.length) return null;
  let expression = node.body;
  if (t.isBlockStatement(expression)) {
    if (expression.directives.length || expression.body.length !== 1 || !t.isReturnStatement(expression.body[0]) || !expression.body[0].argument) return null;
    expression = expression.body[0].argument;
  }
  function safe(value) {
    if (t.isIdentifier(value)) return names.includes(value.name);
    if (t.isStringLiteral(value) || t.isNumericLiteral(value) || t.isBooleanLiteral(value) || t.isNullLiteral(value)) return true;
    if (t.isUnaryExpression(value)) return ['!', '~', '+', '-', 'void', 'typeof'].includes(value.operator) && safe(value.argument);
    if (t.isBinaryExpression(value)) return !['in', 'instanceof'].includes(value.operator) && safe(value.left) && safe(value.right);
    if (t.isLogicalExpression(value)) return safe(value.left) && safe(value.right);
    if (t.isConditionalExpression(value)) return safe(value.test) && safe(value.consequent) && safe(value.alternate);
    return false;
  }
  return safe(expression) ? { expression, names } : null;
}

function expandWrapper(wrapper, args) {
  if (!wrapper || args.length !== wrapper.names.length || args.some(arg => t.isSpreadElement(arg) || evaluate(arg) === UNKNOWN)) return null;
  // Static primitives cannot have side effects, invoke getters, or acquire a
  // receiver. Repetition, reordering, and short-circuiting are therefore safe.
  const replacements = new Map(wrapper.names.map((name, i) => [name, literal(evaluate(args[i]))]));
  function copy(node) {
    if (t.isIdentifier(node) && replacements.has(node.name)) return t.cloneNode(replacements.get(node.name), true);
    const result = t.cloneNode(node, false);
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      if (Array.isArray(node[key])) result[key] = node[key].map(child => child ? copy(child) : child);
      else if (node[key]) result[key] = copy(node[key]);
    }
    return result;
  }
  return copy(wrapper.expression);
}

module.exports = { t, traverse, UNKNOWN, evaluate, literal, dynamicScope, analyzeDynamicScope, isPublic, initializedBefore, isWrite, propertyName, wrapperExpression, expandWrapper };
