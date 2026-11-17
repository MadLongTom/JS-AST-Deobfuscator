'use strict';
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { UNKNOWN, evaluate, analyzeDynamicScope } = require('./_utils');
const { within, memberName } = require('../decoders/scaffolds');

const SOURCE_TRAP = '(((.+)+)+)+$';

function boolean(node) {
  const value = evaluate(node);
  if (value !== UNKNOWN) return !!value;
  if (t.isArrayExpression(node) && !node.elements.length) return true;
  if (t.isUnaryExpression(node, { operator: '!' })) { const argument = boolean(node.argument); return argument === UNKNOWN ? UNKNOWN : !argument; }
  return UNKNOWN;
}

function propertyValue(member) {
  if (!member.isMemberExpression() || !member.get('object').isIdentifier()) return null;
  const name = memberName(member.node), binding = member.scope.getBinding(member.node.object.name);
  if (name === null || !binding || !binding.constant || !binding.path.isVariableDeclarator() || !binding.path.get('init').isObjectExpression()) return null;
  if (binding.path.node.start != null && member.node.start != null && binding.path.node.start > member.node.start) return null;
  for (const reference of binding.referencePaths) {
    const parent = reference.parentPath;
    if (!parent.isMemberExpression() || parent.get('object') !== reference) return null;
    if (parent.parentPath.isAssignmentExpression() && parent.parentPath.get('left') === parent || parent.parentPath.isUpdateExpression() || parent.parentPath.isUnaryExpression({ operator: 'delete' })) return null;
  }
  const candidates = binding.path.get('init.properties').filter(property => property.isObjectProperty() && !property.node.computed && (t.isIdentifier(property.node.key) ? property.node.key.name : property.node.key.value) === name);
  return candidates.length === 1 ? candidates[0].get('value') : null;
}

function constant(path, env = new Map(), seen = new Set(), depth = 0) {
  if (!path || !path.node || depth > 30) return UNKNOWN;
  const direct = evaluate(path.node);
  if (direct !== UNKNOWN) return direct;
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    if (env.has(binding)) return env.get(binding);
    if (!binding || !binding.constant || seen.has(binding) || !binding.path.isVariableDeclarator() || binding.path.node.start >= path.node.start) return UNKNOWN;
    const next = new Set(seen); next.add(binding);
    return constant(binding.path.get('init'), env, next, depth + 1);
  }
  if (path.isMemberExpression()) return constant(propertyValue(path), env, seen, depth + 1);
  if (path.isBinaryExpression() || path.isUnaryExpression()) {
    const read = child => constant(child, env, seen, depth + 1);
    if (path.isUnaryExpression()) { const value = read(path.get('argument')); return value === UNKNOWN ? UNKNOWN : evaluate(t.unaryExpression(path.node.operator, t.valueToNode(value))); }
    const left = read(path.get('left')), right = read(path.get('right'));
    return left === UNKNOWN || right === UNKNOWN ? UNKNOWN : evaluate(t.binaryExpression(path.node.operator, t.valueToNode(left), t.valueToNode(right)));
  }
  if (path.isCallExpression()) {
    let fn = path.get('callee');
    if (fn.isMemberExpression()) fn = propertyValue(fn);
    else if (fn.isIdentifier()) {
      const binding = fn.scope.getBinding(fn.node.name);
      fn = binding && binding.constant && (binding.path.isFunctionDeclaration() ? binding.path : binding.path.isVariableDeclarator() ? binding.path.get('init') : null);
    }
    if (!fn || !fn.isFunction() || fn.node.async || fn.node.generator || !fn.node.params.every(parameter => t.isIdentifier(parameter))) return UNKNOWN;
    const body = fn.get('body');
    if (!body.isBlockStatement() || body.node.body.length !== 1 || !body.get('body.0').isReturnStatement()) return UNKNOWN;
    const values = path.get('arguments').map(argument => constant(argument, env, seen, depth + 1));
    if (values.some(value => value === UNKNOWN)) return UNKNOWN;
    const local = new Map(env);
    fn.get('params').forEach((parameter, index) => local.set(parameter.scope.getBinding(parameter.node.name), values[index]));
    return constant(body.get('body.0.argument'), local, seen, depth + 1);
  }
  return UNKNOWN;
}

function unwrapFactoryCall(call) {
  let callee = call.get('callee'), args = call.get('arguments');
  if (callee.isMemberExpression()) {
    const wrapper = propertyValue(callee);
    if (!wrapper || !wrapper.isFunction() || wrapper.node.async || wrapper.node.generator || !wrapper.get('body').isBlockStatement() || wrapper.node.body.body.length !== 1) return null;
    const statement = wrapper.get('body.body.0');
    if (!statement.isReturnStatement() || !statement.get('argument').isCallExpression()) return null;
    const forwarding = statement.get('argument');
    const argumentFor = reference => {
      if (!reference.isIdentifier()) return null;
      const binding = reference.scope.getBinding(reference.node.name);
      const index = wrapper.get('params').findIndex(parameter => parameter.isIdentifier() && parameter.scope.getBinding(parameter.node.name) === binding);
      return index >= 0 ? args[index] : null;
    };
    callee = argumentFor(forwarding.get('callee'));
    const forwarded = forwarding.get('arguments').map(argumentFor);
    if (!callee || forwarded.some(argument => !argument)) return null;
    args = forwarded;
  }
  if (!callee.isIdentifier() || args.length !== 2 || !args[1].isFunction() || args[1].node.async || args[1].node.generator) return null;
  const binding = callee.scope.getBinding(callee.node.name);
  if (!binding || !binding.constant || !binding.path.isVariableDeclarator()) return null;
  const init = binding.path.get('init');
  if (!init.isCallExpression() || init.node.arguments.length || !init.get('callee').isFunction()) return null;
  const factory = init.get('callee');
  if (factory.node.async || factory.node.generator) return null;
  let matches = false;
  factory.traverse({ ReturnStatement(statement) {
    if (statement.getFunctionParent() !== factory || !statement.get('argument').isFunction()) return;
    const returned = statement.get('argument');
    if (returned.node.async || returned.node.generator || returned.node.params.length !== 2 || !returned.node.params.every(parameter => t.isIdentifier(parameter))) return;
    const [receiver, callback] = returned.get('params').map(parameter => parameter.scope.getBinding(parameter.node.name));
    let apply = false, clear = false, once = false;
    returned.traverse({
      CallExpression(path) {
        const member = path.get('callee');
        if (!member.isMemberExpression() || memberName(member.node) !== 'apply' || !member.get('object').isIdentifier() || member.scope.getBinding(member.node.object.name) !== callback) return;
        const argumentsPaths = path.get('arguments');
        if (argumentsPaths.length === 2 && argumentsPaths[0].isIdentifier() && argumentsPaths[0].scope.getBinding(argumentsPaths[0].node.name) === receiver && argumentsPaths[1].isIdentifier({ name: 'arguments' }) && !argumentsPaths[1].scope.getBinding('arguments')) apply = true;
      },
      AssignmentExpression(path) {
        if (!path.get('left').isIdentifier() || path.node.operator !== '=') return;
        const target = path.scope.getBinding(path.node.left.name);
        if (target === callback && path.get('right').isNullLiteral()) clear = true;
        if (target && within(target.path, factory) && !within(target.path, returned) && target.path.isVariableDeclarator() && boolean(target.path.node.init) === true && boolean(path.node.right) === false) once = true;
      }
    });
    if (apply && clear && once) matches = true;
  } });
  return matches ? { callback: args[1], factory } : null;
}

function trap(path, binding) {
  const method = (call, name, count) => call && call.isCallExpression() && call.node.arguments.length === count && call.get('callee').isMemberExpression() && memberName(call.node.callee) === name;
  if (!method(path, 'search', 1) || constant(path.get('arguments.0')) !== SOURCE_TRAP) return false;
  const constructor = path.get('callee.object');
  if (!method(constructor, 'constructor', 1)) return false;
  const self = constructor.get('arguments.0');
  if (!self.isIdentifier() || self.scope.getBinding(self.node.name) !== binding) return false;
  const numericString = constructor.get('callee.object');
  if (!method(numericString, 'toString', 0)) return false;
  const firstSearch = numericString.get('callee.object');
  if (!method(firstSearch, 'search', 1) || constant(firstSearch.get('arguments.0')) !== SOURCE_TRAP) return false;
  const sourceString = firstSearch.get('callee.object');
  if (!method(sourceString, 'toString', 0)) return false;
  const object = sourceString.get('callee.object');
  return object.isIdentifier() && object.scope.getBinding(object.node.name) === binding;
}

function safeUnusedRead(path, seen = new Set()) {
  if (constant(path) !== UNKNOWN) return true;
  if (!path.isIdentifier()) return false;
  const binding = path.scope.getBinding(path.node.name);
  if (!binding || seen.has(binding)) return false;
  if (binding.path.isFunctionDeclaration()) return true;
  if (!binding.constant || !binding.path.isVariableDeclarator() || binding.path.node.start >= path.node.start) return false;
  const next = new Set(seen); next.add(binding);
  return safeUnusedRead(binding.path.get('init'), next);
}

function run(ast, context) {
  if (context.options.profile !== 'readable') return 0;
  const dynamic = analyzeDynamicScope(ast, { context });
  let changes = 0;
  traverse(ast, { VariableDeclarator(path) {
    if (!path.get('id').isIdentifier() || !path.get('init').isCallExpression()) return;
    if (path.parentPath.parentPath.isExportNamedDeclaration() || path.parentPath.parentPath.isExportDefaultDeclaration()) return;
    const binding = path.scope.getBinding(path.node.id.name);
    if (!binding || !binding.constant) return;
    if (dynamic.affectsBinding(binding) || dynamic.affectsRegion(path)) return;
    const match = unwrapFactoryCall(path.get('init'));
    if (!match || !match.callback.get('body').isBlockStatement()) return;
    const callback = match.callback, statements = callback.get('body.body');
    if (!statements.length || !statements[statements.length - 1].isReturnStatement()) return;
    for (const statement of statements.slice(0, -1)) {
      if (!statement.isVariableDeclaration() || !statement.get('declarations').every(declaration => declaration.get('id').isIdentifier() && (!declaration.node.init || safeUnusedRead(declaration.get('init'))))) return;
    }
    let expression = statements[statements.length - 1].get('argument');
    while (expression.isConditionalExpression()) {
      const condition = constant(expression.get('test'));
      if (condition === UNKNOWN) return;
      expression = expression.get(condition ? 'consequent' : 'alternate');
    }
    if (!trap(expression, binding)) return;
    const external = binding.referencePaths.filter(reference => !within(reference, callback));
    if (!external.length || external.some(reference => !reference.parentPath.isCallExpression() || reference.parentPath.get('callee') !== reference || reference.parentPath.node.arguments.length || !(reference.parentPath.parentPath.isExpressionStatement() || reference.parentPath.parentPath.isSequenceExpression() && reference.parentPath.parentPath.parentPath.isExpressionStatement()))) return;
    const unusedTrapProperties = [];
    callback.traverse({ MemberExpression(member) {
      const value = propertyValue(member);
      if (value && value.isStringLiteral({ value: SOURCE_TRAP })) unusedTrapProperties.push(value.parentPath);
    } });
    callback.get('body').replaceWith(t.blockStatement([]));
    for (const property of unusedTrapProperties) {
      if (!property.node || property.removed) continue;
      const object = property.parentPath.parentPath;
      if (!object.isVariableDeclarator()) continue;
      const owner = object.scope.getBinding(object.node.id.name), name = t.isIdentifier(property.node.key) ? property.node.key.name : property.node.key.value;
      if (owner && owner.referencePaths.every(reference => !reference.parentPath.isMemberExpression() || memberName(reference.parentPath.node) !== name || within(reference, callback))) property.remove();
    }
    changes++;
    context.warn('SOURCE_SELF_DEFENSE_NEUTRALIZED', 'Neutralized a recognized once-only source-text self-check under the readable profile.', {
      helper: binding.identifier.name, line: path.node.loc && path.node.loc.start.line, pattern: SOURCE_TRAP,
      assumption: 'Source-text anti-tamper checks are intentionally disabled for this analysis artifact; this profile does not preserve that protection.'
    });
  } });
  return changes;
}

module.exports = { name: 'neutralize-self-defense', description: 'Readable-only neutralization of recognized once-only javascript-obfuscator source-text traps.', run };
