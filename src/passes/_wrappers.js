'use strict';

const { t, UNKNOWN, evaluate, literal } = require('./_utils');

// Wrapper bodies are interpreted as syntax, never executed. Parameter-only
// expressions can be moved hygienically; the few permitted unused alias reads
// are retained and checked against the call site's lexical bindings.
function analyzeWrapper(path) {
  if (!path || !path.node || !path.isFunction() || path.node.async || path.node.generator) return null;
  const node = path.node;
  if (!node.params.every(param => t.isIdentifier(param) && !['eval', 'arguments'].includes(param.name))) return null;
  const names = node.params.map(param => param.name);
  if (new Set(names).size !== names.length) return null;
  const prefixes = [];
  let expression;
  if (t.isBlockStatement(node.body)) {
    const statements = path.get('body.body');
    if (!statements.length || !statements.at(-1).isReturnStatement() || !statements.at(-1).node.argument) return null;
    for (const statement of statements.slice(0, -1)) {
      if (!statement.isVariableDeclaration({ kind: 'var' })) return null;
      for (const declaration of statement.get('declarations')) {
        if (!t.isIdentifier(declaration.node.id) || names.includes(declaration.node.id.name)) return null;
        const binding = declaration.scope.getBinding(declaration.node.id.name);
        if (!binding || binding.referenced || binding.constantViolations.length) return null;
        const init = declaration.get('init');
        if (!init.node || evaluate(init.node) !== UNKNOWN || init.isFunctionExpression() || init.isArrowFunctionExpression()) continue;
        if (!init.isIdentifier()) return null;
        if (!names.includes(init.node.name)) prefixes.push({ node: init.node, binding: init.scope.getBinding(init.node.name) });
      }
    }
    expression = statements.at(-1).node.argument;
  } else expression = node.body;
  function safe(value) {
    if (t.isIdentifier(value)) return names.includes(value.name);
    if (t.isStringLiteral(value) || t.isNumericLiteral(value) || t.isBooleanLiteral(value) || t.isNullLiteral(value)) return true;
    if (t.isUnaryExpression(value)) return ['!', '~', '+', '-', 'void', 'typeof'].includes(value.operator) && safe(value.argument);
    if (t.isBinaryExpression(value)) return safe(value.left) && safe(value.right);
    if (t.isLogicalExpression(value)) return safe(value.left) && safe(value.right);
    if (t.isConditionalExpression(value)) return safe(value.test) && safe(value.consequent) && safe(value.alternate);
    if (t.isCallExpression(value)) return !value.optional && t.isIdentifier(value.callee) && names.includes(value.callee.name) && value.callee.name !== 'eval' && value.arguments.every(arg => !t.isSpreadElement(arg) && safe(arg));
    return false;
  }
  return safe(expression) ? { expression, names, prefixes } : null;
}

function copyExpression(node, replacements) {
  if (t.isIdentifier(node) && replacements.has(node.name)) return t.cloneNode(replacements.get(node.name), true);
  const result = t.cloneNode(node, false);
  for (const key of t.VISITOR_KEYS[node.type] || []) {
    if (Array.isArray(node[key])) result[key] = node[key].map(child => child ? copyExpression(child, replacements) : child);
    else if (node[key]) result[key] = copyExpression(node[key], replacements);
  }
  if (t.isCallExpression(result) && (t.isMemberExpression(result.callee) || t.isOptionalMemberExpression(result.callee) || t.isIdentifier(result.callee, { name: 'eval' }))) {
    result.callee = t.sequenceExpression([t.numericLiteral(0), result.callee]);
  }
  // typeof a parameter performs GetValue on its argument at the outer call.
  if (t.isUnaryExpression(result, { operator: 'typeof' }) && t.isIdentifier(result.argument)) result.argument = t.sequenceExpression([t.numericLiteral(0), result.argument]);
  return result;
}

function asValue(call, node) {
  const parent = call.parentPath;
  const reference = t.isIdentifier(node) || t.isMemberExpression(node) || t.isOptionalMemberExpression(node);
  if (reference && ((parent.isCallExpression() || parent.isOptionalCallExpression()) && call.key === 'callee' || parent.isTaggedTemplateExpression() && call.key === 'tag' || parent.isUnaryExpression({ operator: 'typeof' }) || parent.isUnaryExpression({ operator: 'delete' }))) return t.sequenceExpression([t.numericLiteral(0), node]);
  return node;
}

// These shapes evaluate every argument exactly once in its original order,
// and perform all coercions only after both argument expressions are read.
function directShape(wrapper, args) {
  if (wrapper.prefixes.length || args.length !== wrapper.names.length) return false;
  const names = wrapper.names, expression = wrapper.expression;
  if (t.isIdentifier(expression)) return names.length === 1 && expression.name === names[0];
  if (t.isUnaryExpression(expression)) return names.length === 1 && t.isIdentifier(expression.argument, { name: names[0] });
  if (t.isBinaryExpression(expression)) return names.length === 2 && t.isIdentifier(expression.left, { name: names[0] }) && t.isIdentifier(expression.right, { name: names[1] });
  if (t.isCallExpression(expression)) return names.length >= 1 && t.isIdentifier(expression.callee, { name: names[0] }) && expression.arguments.length === names.length - 1 && expression.arguments.every((arg, i) => t.isIdentifier(arg, { name: names[i + 1] }));
  return false;
}

function bodyScope(call) {
  const scope = call.scope.getFunctionParent();
  if (!scope || !scope.path.isFunction() || !scope.path.get('body').isBlockStatement()) return null;
  let child = call;
  while (child && child.parentPath !== scope.path) child = child.parentPath;
  return child && child.key === 'body' ? scope : null;
}

function expandWrapper(wrapper, call) {
  if (!wrapper || call.node.optional || call.node.arguments.some(arg => t.isSpreadElement(arg) || t.isArgumentPlaceholder(arg))) return null;
  for (const prefix of wrapper.prefixes) if (call.scope.getBinding(prefix.node.name) !== prefix.binding) return null;
  const args = call.node.arguments;
  if (directShape(wrapper, args) || !wrapper.prefixes.length && args.length === wrapper.names.length && args.every(arg => evaluate(arg) !== UNKNOWN)) {
    const replacements = new Map(wrapper.names.map((name, i) => [name, t.cloneNode(args[i], true)]));
    return asValue(call, copyExpression(wrapper.expression, replacements));
  }
  // Materialize all original arguments before the body. This preserves eager
  // evaluation for logical/conditional wrappers, dropped/repeated arguments,
  // reordered parameters, and object coercion hooks.
  const target = bodyScope(call);
  const used = new Set();
  t.traverseFast(wrapper.expression, node => { if (t.isIdentifier(node) && wrapper.names.includes(node.name)) used.add(node.name); });
  const ids = args.map((_arg, i) => used.has(wrapper.names[i]) ? call.scope.generateUidIdentifier('arg') : null);
  const replacements = new Map(wrapper.names.map((name, i) => [name, ids[i] || literal(undefined)]));
  const body = [...wrapper.prefixes.map(prefix => t.cloneNode(prefix.node, true)), copyExpression(wrapper.expression, replacements)];
  const evaluations = args.map((arg, i) => ids[i] ? t.assignmentExpression('=', t.cloneNode(ids[i]), t.cloneNode(arg, true)) : evaluate(arg) === UNKNOWN ? t.cloneNode(arg, true) : null).filter(Boolean);
  if (!ids.some(Boolean)) return asValue(call, evaluations.length + body.length === 1 ? [...evaluations, ...body][0] : t.sequenceExpression([...evaluations, ...body]));
  if (target) {
    // unique prevents Babel's anonymous-IIFE optimization from adding these
    // bindings as formal parameters (which would change length/arguments).
    for (const id of ids.filter(Boolean)) target.push({ id: t.cloneNode(id), kind: 'var', unique: true });
    return t.sequenceExpression([...evaluations, ...body]);
  }
  // Parameter initializers, concise arrows, class fields and top-level code
  // cannot safely share function-body temporaries. An isolated arrow parameter
  // scope retains argument evaluation in the original enclosing context.
  const parameters = ids.map(id => id ? t.cloneNode(id) : call.scope.generateUidIdentifier('unused'));
  return t.callExpression(t.arrowFunctionExpression(parameters, body.length === 1 ? body[0] : t.sequenceExpression(body)), args.map(arg => t.cloneNode(arg, true)));
}

function ignoresReceiver(node) {
  if (!t.isFunctionExpression(node) && !t.isArrowFunctionExpression(node)) return false;
  let safe = true;
  t.traverseFast(node, value => {
    if (t.isThisExpression(value) || t.isSuper(value) || t.isMetaProperty(value) || t.isIdentifier(value, { name: 'arguments' })) safe = false;
  });
  return safe;
}

module.exports = { analyzeWrapper, expandWrapper, ignoresReceiver };
