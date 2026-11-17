'use strict';

const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const { t, traverse, propertyName, isWrite, analyzeDynamicScope } = require('../passes/_utils');
const { dominates } = require('../passes/_dispatch');
const UNKNOWN = Symbol('unknown-constructor');

function inside(path, ancestor) { for (let at = path; at; at = at.parentPath) if (at === ancestor) return true; return false; }
function own(path, parent) { let at = path; while (at && at.parentPath !== parent) at = at.parentPath; return at && at.inList && at.listKey === 'body' ? at : null; }
function id(node, name) { return t.isIdentifier(node, { name }); }
function proto(node, name) { return t.isMemberExpression(node) && propertyName(node) === 'prototype' && id(node.object, name); }
function single(node) { while (t.isBlockStatement(node) && node.body.length === 1) node = node.body[0]; return node; }
function functionPath(binding) { return binding && (binding.path.isFunctionDeclaration() ? binding.path : binding.path.isVariableDeclarator() && binding.path.get('init').isFunctionExpression() ? binding.path.get('init') : null); }
function sourceLoc(path) { if (path.node.loc) return path.node.loc; let location; t.traverseFast(path.node, node => { if (!location && node.loc) location = node.loc; }); return location; }
function removeDeclaration(path) {
  if (!path || !path.node || path.removed) return;
  if (path.isVariableDeclarator()) { if (path.parentPath.node.declarations.length === 1) path.parentPath.remove(); else path.remove(); }
  else path.remove();
}
function resultUse(path) {
  let at = path;
  while (at.parentPath) {
    const parent = at.parentPath;
    if (parent.isSequenceExpression() && at.key === parent.node.expressions.length - 1 || parent.isConditionalExpression() && ['consequent', 'alternate'].includes(at.key) || parent.isLogicalExpression() || parent.isAssignmentExpression({ operator: '=' }) && at.key === 'right' || parent.isParenthesizedExpression()) at = parent;
    else break;
  }
  return at;
}
function canonicalArgument(path) {
  if (path.isIdentifier()) return !!path.scope.getBinding(path.node.name);
  if (!path.isAssignmentExpression({ operator: '=' }) || !path.get('left').isIdentifier()) return false;
  const target = path.scope.getBinding(path.node.left.name);
  // TS's temporary assignments use initialized var/parameter bindings. Do not
  // erase an assignment-to-const or a possible lexical TDZ exception as cleanup.
  return !!target && ['var', 'param'].includes(target.kind) && canonicalArgument(path.get('right'));
}
function hazard(path) {
  let issue = null;
  path.traverse({
    WithStatement() { issue = 'with prevents class strictness analysis'; },
    CallExpression(at) { if (at.get('callee').isIdentifier({ name: 'eval' })) issue = 'direct eval prevents class strictness analysis'; },
    MetaProperty() { issue = 'new.target is observed'; },
    Super() { issue = 'existing super is not a canonical ES5 constructor'; },
    MemberExpression(at) { if (id(at.node.object, 'arguments') && ['callee', 'caller'].includes(propertyName(at.node))) issue = 'arguments.callee/caller depends on sloppy function semantics'; },
  });
  return issue;
}

// Exact static half of the TypeScript-style ES5 inheritance helper. A helper
// containing an extra callback, log, write, or other branch is not recognized.
function staticHelper(binding) {
  const fn = functionPath(binding);
  if (!fn || fn.node.params.length !== 2 || !fn.node.params.every(t.isIdentifier) || fn.node.async || fn.node.generator) return false;
  if (binding.path.isVariableDeclarator() && binding.path.parentPath.node.kind === 'const') return false;
  if (binding.constantViolations.some(write => !inside(write, fn))) return false;
  const body = fn.node.body.body;
  if (body.length !== 1 || !t.isReturnStatement(body[0]) || !t.isCallExpression(body[0].argument)) return false;
  const call = body[0].argument, names = fn.node.params.map(parameter => parameter.name);
  if (call.arguments.length !== 2 || !call.arguments.every((argument, index) => id(argument, names[index])) || !t.isAssignmentExpression(call.callee, { operator: '=' }) || !id(call.callee.left, binding.identifier.name)) return false;
  const alternatives = [];
  function flatten(node) { if (t.isLogicalExpression(node, { operator: '||' })) { flatten(node.left); flatten(node.right); } else alternatives.push(node); }
  flatten(call.callee.right);
  if (alternatives.length !== 3) return false;
  if (!t.isMemberExpression(alternatives[0]) || !id(alternatives[0].object, 'Object') || propertyName(alternatives[0]) !== 'setPrototypeOf' || fn.scope.getBinding('Object') || fn.scope.getBinding('Array')) return false;
  const fallback = alternatives[1];
  if (!t.isLogicalExpression(fallback, { operator: '&&' }) || !t.isBinaryExpression(fallback.left, { operator: 'instanceof' }) || !id(fallback.left.right, 'Array') || !t.isObjectExpression(fallback.left.left) || fallback.left.left.properties.length !== 1) return false;
  const testProperty = fallback.left.left.properties[0];
  if (!t.isObjectProperty(testProperty) || (testProperty.key.name || testProperty.key.value) !== '__proto__' || !t.isArrayExpression(testProperty.value) || testProperty.value.elements.length) return false;
  const set = fallback.right, copy = alternatives[2];
  if (![set, copy].every(node => t.isFunctionExpression(node) && !node.async && !node.generator && node.params.length === 2 && node.params.every(t.isIdentifier) && node.body.body.length === 1)) return false;
  const [derived, base] = set.params.map(parameter => parameter.name);
  const setting = single(set.body.body[0]);
  if (!t.isExpressionStatement(setting) || !t.isAssignmentExpression(setting.expression, { operator: '=' }) || !t.isMemberExpression(setting.expression.left) || !id(setting.expression.left.object, derived) || propertyName(setting.expression.left) !== '__proto__' || !id(setting.expression.right, base)) return false;
  const [to, from] = copy.params.map(parameter => parameter.name), loop = copy.body.body[0];
  if (!t.isForInStatement(loop) || !id(loop.right, from) || !t.isVariableDeclaration(loop.left) || loop.left.declarations.length !== 1 || !t.isIdentifier(loop.left.declarations[0].id)) return false;
  const key = loop.left.declarations[0].id.name, operation = single(loop.body);
  let guard, write;
  if (t.isIfStatement(operation) && !operation.alternate) { guard = operation.test; const statement = single(operation.consequent); if (t.isExpressionStatement(statement)) write = statement.expression; }
  if (t.isExpressionStatement(operation) && t.isLogicalExpression(operation.expression, { operator: '&&' })) { guard = operation.expression.left; write = operation.expression.right; }
  return !!(guard && write && t.isCallExpression(guard) && t.isMemberExpression(guard.callee) && id(guard.callee.object, from) && propertyName(guard.callee) === 'hasOwnProperty' && guard.arguments.length === 1 && id(guard.arguments[0], key) && t.isAssignmentExpression(write, { operator: '=' }) && t.isMemberExpression(write.left) && write.left.computed && id(write.left.object, to) && id(write.left.property, key) && t.isMemberExpression(write.right) && write.right.computed && id(write.right.object, from) && id(write.right.property, key));
}

function scopeData(parent) {
  const env = new Map(), events = new Map(), reads = new Map(), calls = [], assignments = [], eventNodes = new Set(), helperCache = new Map();
  for (const sibling of parent.get('body')) if (sibling.isFunctionDeclaration() && sibling.node.id) { const binding = sibling.parentPath.scope.getBinding(sibling.node.id.name); env.set(binding, binding); }
  let index = 0;
  const write = (binding, value, path) => { if (!binding) return; env.set(binding, value); if (!events.has(binding)) events.set(binding, []); events.get(binding).push({ value, path, index }); eventNodes.add(path.node); };
  function read(path) {
    if (!path || !path.node) return UNKNOWN;
    if (path.isFunction()) return UNKNOWN;
    if (path.isReferencedIdentifier()) { const binding = path.scope.getBinding(path.node.name), value = env.get(binding) || UNKNOWN; reads.set(path.node, value); return value; }
    if (path.isAssignmentExpression()) {
      if (path.get('left').isMemberExpression()) read(path.get('left'));
      const value = read(path.get('right'));
      if (path.get('left').isIdentifier()) write(path.scope.getBinding(path.node.left.name), path.node.operator === '=' ? value : UNKNOWN, path);
      if (path.parentPath.isExpressionStatement() && path.parentPath.parentPath === parent) assignments.push(path);
      return path.node.operator === '=' ? value : UNKNOWN;
    }
    if (path.isUpdateExpression()) { read(path.get('argument')); if (path.get('argument').isIdentifier()) write(path.scope.getBinding(path.node.argument.name), UNKNOWN, path); return UNKNOWN; }
    if (path.isSequenceExpression()) { let value; for (const expression of path.get('expressions')) value = read(expression); return value; }
    if (path.isCallExpression()) {
      read(path.get('callee'));
      const values = path.get('arguments').map(read);
      if (path.get('callee').isIdentifier() && path.node.arguments.length === 2 && path.parentPath.isExpressionStatement() && path.parentPath.parentPath === parent) {
        const helper = path.scope.getBinding(path.node.callee.name);
        if (!helperCache.has(helper)) helperCache.set(helper, staticHelper(helper));
        if (helperCache.get(helper) && values.every(value => value !== UNKNOWN && value.path.isFunctionDeclaration())) calls.push({ path, helper, child: values[0], base: values[1], index, canonicalArguments: path.get('arguments').every(canonicalArgument) });
      }
      return UNKNOWN;
    }
    if (path.isVariableDeclaration()) { for (const declaration of path.get('declarations')) if (declaration.get('id').isIdentifier() && declaration.node.init) write(declaration.scope.getBinding(declaration.node.id.name), read(declaration.get('init')), declaration); return UNKNOWN; }
    if (path.isIfStatement() || path.isConditionalExpression() || path.isLogicalExpression()) {
      // Branch-dependent local constructor aliases are deliberately unknown.
      const before = new Map(env);
      for (const key of t.VISITOR_KEYS[path.node.type] || []) {
        const child = path.get(key); if (Array.isArray(child)) child.forEach(read); else read(child);
      }
      for (const [binding, value] of env) if (before.get(binding) !== value) env.set(binding, UNKNOWN);
      return UNKNOWN;
    }
    for (const key of t.VISITOR_KEYS[path.node.type] || []) {
      const child = path.get(key); if (Array.isArray(child)) child.forEach(read); else read(child);
    }
    return UNKNOWN;
  }
  parent.get('body').forEach((sibling, at) => { index = at; if (!sibling.isFunctionDeclaration()) read(sibling); });
  const stable = binding => {
    if (!binding) return UNKNOWN;
    if (binding.path.isFunctionDeclaration()) return binding;
    if (binding.constantViolations.some(write => !eventNodes.has(write.node))) return UNKNOWN;
    const versions = events.get(binding) || [];
    if (!versions.length || versions.some(event => event.value === UNKNOWN)) return UNKNOWN;
    const value = versions[0].value;
    return versions.every(event => event.value === value) ? value : UNKNOWN;
  };
  const origin = path => reads.has(path.node) ? reads.get(path.node) : path.isIdentifier() ? stable(path.scope.getBinding(path.node.name)) : UNKNOWN;
  return { calls, assignments, events, reads, stable, origin, eventNodes };
}

function methodConstructed(path, active = new Set()) {
  path = resultUse(path);
  const parent = path.parentPath;
  if (parent.isNewExpression() && parent.get('callee') === path) return true;
  if (parent.isMemberExpression() && parent.get('object') === path && ['prototype', 'bind'].includes(propertyName(parent.node))) return true;
  if (parent.isCallExpression() && parent.get('callee').isMemberExpression() && propertyName(parent.node.callee) === 'construct' && path.listKey === 'arguments' && path.key === 0) return true;
  if (parent.isVariableDeclarator() && parent.get('init') === path && t.isIdentifier(parent.node.id)) {
    const binding = parent.scope.getBinding(parent.node.id.name);
    if (!binding || !binding.constant || active.has(binding)) return true;
    active.add(binding); const result = binding.referencePaths.some(reference => methodConstructed(reference, active)); active.delete(binding); return result;
  }
  return false;
}

function prototypeInstall(record, parent, data) {
  const statement = parent.get('body')[record.index + 1];
  if (!statement || !statement.isExpressionStatement() || !statement.get('expression').isAssignmentExpression({ operator: '=' })) return null;
  const assignment = statement.get('expression'), left = assignment.get('left'), right = assignment.get('right');
  if (!left.isMemberExpression() || propertyName(left.node) !== 'prototype' || !left.get('object').isIdentifier() || data.origin(left.get('object')) !== record.child || !right.isConditionalExpression()) return null;
  const test = right.node.test;
  if (!t.isBinaryExpression(test) || !['===', '=='].includes(test.operator)) return null;
  const tested = t.isNullLiteral(test.left) ? right.get('test.right') : t.isNullLiteral(test.right) ? right.get('test.left') : null;
  if (!tested || !tested.isIdentifier() || data.origin(tested) !== record.base) return null;
  const create = right.get('consequent');
  if (!create.isCallExpression() || create.node.arguments.length !== 1 || !create.get('callee').isMemberExpression() || !id(create.node.callee.object, 'Object') || propertyName(create.node.callee) !== 'create' || create.scope.getBinding('Object') || data.origin(create.get('arguments.0')) !== record.base) return null;
  const alternate = right.get('alternate');
  if (!alternate.isSequenceExpression() || alternate.node.expressions.length !== 2) return null;
  const set = alternate.get('expressions.0'), instance = alternate.get('expressions.1');
  if (!set.isAssignmentExpression({ operator: '=' }) || !set.get('left').isMemberExpression() || propertyName(set.node.left) !== 'prototype' || !t.isIdentifier(set.node.left.object) || !set.get('right').isMemberExpression() || propertyName(set.node.right) !== 'prototype' || data.origin(set.get('right.object')) !== record.base || !instance.isNewExpression() || instance.node.arguments.length || !instance.get('callee').isIdentifier()) return null;
  const bridge = set.scope.getBinding(set.node.left.object.name);
  if (!bridge || !bridge.constant || bridge.constantViolations.length || bridge !== instance.scope.getBinding(instance.node.callee.name) || !bridge.path.isFunctionDeclaration() || bridge.path.node.params.length || bridge.path.node.body.body.length !== 1) return null;
  const body = bridge.path.get('body.body.0');
  if (!body.isExpressionStatement() || !body.get('expression').isAssignmentExpression({ operator: '=' }) || !body.get('expression.left').isMemberExpression() || !t.isThisExpression(body.node.expression.left.object) || propertyName(body.node.expression.left) !== 'constructor' || data.origin(body.get('expression.right')) !== record.child) return null;
  if (bridge.referencePaths.some(reference => !inside(reference, statement))) return null;
  return { statement, bridge };
}

function analyze(record, parent, data) {
  const candidate = { ...record, parent, basePath: record.base.path, childPath: record.child.path, methods: [], statics: [], skip: null };
  const fail = reason => { candidate.skip = reason; return candidate; };
  const helperBody = functionPath(record.helper);
  if (record.helper.referencePaths.some(reference => !inside(reference, helperBody) && !inside(reference, record.path))) return fail('the self-specializing inheritance helper is reused or observed outside this family');
  if (!record.canonicalArguments) return fail('inheritance helper arguments contain non-canonical effects or value wrappers');
  const installation = prototypeInstall(record, parent, data);
  if (!installation) return fail('prototype installation is not the supported canonical bridge pattern');
  Object.assign(candidate, installation);
  if (record.base === record.child || candidate.basePath.parentPath !== parent || candidate.childPath.parentPath !== parent) return fail('parent and child are not distinct constructors in one lexical scope');
  if (!record.base.constant || record.base.constantViolations.length || !record.child.constant || record.child.constantViolations.length) return fail('parent or child constructor is reassigned');
  for (const fn of [candidate.basePath, candidate.childPath]) if (fn.node.async || fn.node.generator || hazard(fn)) return fail(hazard(fn) || 'asynchronous/generator constructor');
  let parameterThis = false;
  for (const parameter of candidate.childPath.node.params) t.traverseFast(parameter, node => { if (t.isThisExpression(node)) parameterThis = true; });
  if (parameterThis) return fail('derived parameters evaluate this before super initialization');
  let parentReturn = false;
  candidate.basePath.traverse({ Function(path) { path.skip(); }, ReturnStatement(path) { if (path.node.argument && !t.isThisExpression(path.node.argument)) parentReturn = true; } });
  if (parentReturn) return fail('parent returns a value other than this; Parent.call and super can have different return semantics');
  const body = candidate.childPath.get('body.body').filter(statement => !statement.isEmptyStatement());
  if (body.length < 2 || !body[0].isVariableDeclaration() || body[0].node.declarations.length !== 1) return fail('derived constructor does not begin with a single captured super call');
  const local = body[0].get('declarations.0'), init = local.get('init');
  if (!local.get('id').isIdentifier() || !init.isLogicalExpression({ operator: '||' }) || !init.get('right').isThisExpression() || !init.get('left').isCallExpression()) return fail('derived super result is not captured as Parent.call(this) || this');
  const call = init.get('left'), callee = call.get('callee');
  if (!callee.isMemberExpression() || propertyName(callee.node) !== 'call' || !callee.get('object').isIdentifier() || data.stable(callee.scope.getBinding(callee.node.object.name)) !== record.base || !call.node.arguments.length || !call.get('arguments.0').isThisExpression()) return fail('captured parent alias is not stable or super receiver is not this');
  let earlyThis = false;
  for (const argument of call.get('arguments').slice(1)) t.traverseFast(argument.node, node => { if (t.isThisExpression(node)) earlyThis = true; });
  if (earlyThis) return fail('super arguments read this before super initialization');
  const alias = local.scope.getBinding(local.node.id.name), terminal = body[body.length - 1];
  if (!alias || !alias.constant || !terminal.isReturnStatement() || !terminal.get('argument').isIdentifier() || terminal.scope.getBinding(terminal.node.argument.name) !== alias) return fail('derived constructor reassigns or does not return its captured super result');
  let otherReturn = false;
  candidate.childPath.traverse({ Function(path) { path.skip(); }, ReturnStatement(path) { if (path !== terminal) otherReturn = true; } });
  if (otherReturn) return fail('derived constructor has additional return paths');
  candidate.superCall = call;
  const roots = new Set([record.base, record.child]);
  for (const assignment of data.assignments) {
    const left = assignment.get('left');
    if (!left.isMemberExpression()) continue;
    let root = left.get('object'), isStatic = true;
    if (root.isMemberExpression() && propertyName(root.node) === 'prototype') { root = root.get('object'); isStatic = false; }
    if (!root.isIdentifier()) continue;
    const origin = data.origin(root);
    if (!roots.has(origin) || inside(assignment, candidate.statement)) continue;
    const key = propertyName(left.node);
    if (propertyName(left.node) === 'prototype' && isStatic) { if (assignment !== candidate.statement.get('expression')) return fail('additional prototype replacement'); continue; }
    if (!assignment.get('right').isFunctionExpression() || key === null || ['constructor', '__proto__', 'prototype', 'caller', 'arguments', 'name', 'length'].includes(key)) return fail('non-simple, dynamic, or special method installation');
    const fn = assignment.get('right'), issue = hazard(fn);
    if (issue || fn.node.id && fn.scope.getBinding(fn.node.id.name) && fn.scope.getBinding(fn.node.id.name).referenced) return fail(issue || 'method has a private recursive function name');
    const method = { owner: origin, key, fn, statement: assignment.parentPath, static: isStatic };
    (isStatic ? candidate.statics : candidate.methods).push(method);
  }
  const all = [...candidate.methods, ...candidate.statics];
  if (!candidate.methods.some(method => method.owner === record.base) || !candidate.methods.some(method => method.owner === record.child)) return fail('both constructors must have a complete simple prototype-method family');
  if (new Set(all.map(method => `${method.owner.identifier.name}:${method.static}:${method.key}`)).size !== all.length) return fail('a family method is installed more than once');
  const baseMethods = all.filter(method => method.owner === record.base), childMethods = all.filter(method => method.owner === record.child);
  candidate.baseAnchor = Math.min(candidate.basePath.key, ...baseMethods.map(method => method.statement.key));
  candidate.childAnchor = record.index;
  const baseLast = baseMethods.reduce((last, method) => last.key > method.statement.key ? last : method.statement, baseMethods[0].statement);
  const childLast = childMethods.reduce((last, method) => last.key > method.statement.key ? last : method.statement, childMethods[0].statement);
  for (const [binding, events] of data.events) for (const event of events) if (event.value === record.base && event.index < candidate.baseAnchor) candidate.baseAnchor = event.index;
  const owned = new Set([candidate.basePath.node, candidate.childPath.node, ...all.map(method => method.fn.node)]);
  const allowedStatements = new Set([candidate.basePath.node, candidate.childPath.node, candidate.bridge.path.node, record.path.parentPath.node, candidate.statement.node, ...all.map(method => method.statement.node)]);
  for (const [start, last] of [[candidate.baseAnchor, baseLast.key], [candidate.childAnchor, childLast.key]]) {
    for (const sibling of parent.get('body').slice(start, last + 1)) {
      if (allowedStatements.has(sibling.node) || sibling.isEmptyStatement() || sibling.isFunctionDeclaration()) continue;
      if (sibling.isVariableDeclaration() && sibling.get('declarations').every(declaration => !declaration.node.init || declaration.get('init').isIdentifier() && roots.has(data.origin(declaration.get('init'))))) continue;
      return fail('executable observations separate constructor placement and method installation');
    }
  }
  const aliases = new Set([...roots, ...[...data.events].filter(([, events]) => events.some(event => roots.has(event.value))).map(([binding]) => binding)]);
  candidate.aliases = aliases;
  for (const binding of aliases) {
    if (!roots.has(binding) && binding.constantViolations.some(write => !data.eventNodes.has(write.node))) return fail('a constructor alias is written from an unresolved closure or control-flow context');
    for (const reference of binding.referencePaths) {
      const origin = data.origin(reference);
      if (origin !== UNKNOWN && !roots.has(origin)) continue;
      if (origin === UNKNOWN) return fail('a mutable constructor alias is read in an unresolved execution context');
      const use = resultUse(reference), direct = reference.parentPath;
      if ((use.parentPath.isCallExpression() || use.parentPath.isOptionalCallExpression()) && use.parentPath.get('callee') === use) return fail('parent/child constructor is called without new');
      if (direct.isMemberExpression() && ['call', 'apply', 'bind', 'caller', 'arguments'].includes(propertyName(direct.node))) { if (direct !== candidate.superCall.get('callee')) return fail('constructor alias is invoked through an unsupported call/apply/bind'); }
      if (inside(reference, candidate.statement) || inside(reference, record.path) || inside(reference, candidate.bridge.path)) continue;
      if (direct.isMemberExpression() && propertyName(direct.node) === 'prototype') {
        if (isWrite(direct)) return fail('unknown prototype replacement');
        const member = direct.parentPath;
        if (member.isMemberExpression() && member.get('object') === direct) {
          if (methodConstructed(member)) return fail('a prototype method is constructed or its constructibility is observed');
          if (isWrite(member) && !all.some(method => inside(member, method.statement))) return fail('prototype mutation outside recognized method installations');
        } else if (member.isCallExpression()) {
          const callee = member.get('callee');
          if (!callee.isMemberExpression() || !id(callee.node.object, 'Object') || propertyName(callee.node) !== 'getPrototypeOf') return fail('prototype escapes into an unknown helper or descriptor operation');
        } else if (!member.isBinaryExpression()) return fail('prototype escapes');
      } else if (direct.isMemberExpression() && methodConstructed(direct)) return fail('a static method is used as a constructor');
      if (direct.isVariableDeclarator() && direct.get('init') === reference || direct.isAssignmentExpression() && direct.get('right') === reference && direct.get('left').isIdentifier()) {
        const placement = own(reference, parent);
        if (origin === record.child && placement && placement.key < candidate.childAnchor) return fail('child alias is initialized before the canonical class installation anchor');
        continue;
      }
      if (inside(reference, candidate.basePath) || inside(reference, candidate.childPath) || all.some(method => inside(reference, method.fn))) continue;
      if (all.some(method => inside(reference, method.statement))) continue;
      const ready = origin === record.base ? baseLast : childLast;
      if (!dominates(ready, reference, owned)) return fail('constructor or prototype can be observed before installation completes');
      if (direct.isCallExpression() && direct.get('callee') !== reference) {
        const callee = direct.get('callee');
        if (!callee.isMemberExpression() || !id(callee.node.object, 'Object') || propertyName(callee.node) !== 'getPrototypeOf') return fail('constructor escapes to an unknown helper');
      }
    }
  }
  let builtinMutation = false;
  const program = parent.isProgram() ? parent : parent.findParent(path => path.isProgram());
  program.traverse({ MemberExpression(path) { if (id(path.node.object, 'Object') && ['create', 'setPrototypeOf', 'prototype'].includes(propertyName(path.node)) && isWrite(path)) builtinMutation = true; } });
  if (builtinMutation) return fail('Object inheritance builtins are explicitly mutated');
  return candidate;
}

function classDeclaration(candidate, binding, base) {
  const path = binding.path, body = t.cloneNode(path.node.body, true);
  if (base) {
    const local = body.body.find(statement => !t.isEmptyStatement(statement)).declarations[0];
    local.init = t.callExpression(t.super(), candidate.superCall.node.arguments.slice(1).map(argument => t.cloneNode(argument, true)));
  }
  const constructor = t.classMethod('constructor', t.identifier('constructor'), path.node.params.map(parameter => t.cloneNode(parameter, true)), body);
  const methods = [...candidate.methods, ...candidate.statics].filter(method => method.owner === binding).map(method => {
    const fn = method.fn.node, node = t.classMethod('method', t.isValidIdentifier(method.key) ? t.identifier(method.key) : t.stringLiteral(method.key), fn.params.map(parameter => t.cloneNode(parameter, true)), t.cloneNode(fn.body, true), false, method.static);
    node.async = fn.async; node.generator = fn.generator; node.loc = fn.loc; t.inheritsComments(node, method.statement.node); return node;
  });
  const declaration = t.classDeclaration(t.identifier(binding.identifier.name), base ? t.identifier(base.identifier.name) : null, t.classBody([constructor, ...methods]));
  declaration.loc = path.node.loc; t.inheritsComments(declaration, path.node);
  parser.parse(generate(declaration).code, { sourceType: 'script' });
  return declaration;
}

function cleanupAliases(ast, candidates) {
  for (let iteration = 0; iteration < 4; iteration++) {
    traverse(ast, { Program(path) { path.scope.crawl(); path.stop(); } });
    let changes = 0;
    for (const item of candidates) {
      if (!item.node || item.removed || !item.isExpressionStatement()) continue;
      function simplify(node, scope) {
        if (!t.isAssignmentExpression(node, { operator: '=' }) || !t.isIdentifier(node.left)) return node;
        node.right = simplify(node.right, scope);
        const binding = scope.getBinding(node.left.name);
        if (binding && !binding.referenced) { changes++; return node.right; }
        if (t.isIdentifier(node.right, { name: node.left.name })) { changes++; return node.right; }
        return node;
      }
      const expression = simplify(item.node.expression, item.scope);
      if (t.isIdentifier(expression)) { item.remove(); changes++; } else item.node.expression = expression;
    }
    if (!changes) break;
  }
  traverse(ast, { Program(path) { path.scope.crawl(); path.stop(); } });
}

// The phase only rewrites a complete parent/child family after all schema,
// alias-version, placement, constructor-return and method-use checks succeed.
function modernizeInheritance(ast, context = {}) {
  const result = { changes: 0, converted: [], skipped: [] }, warn = (code, message, details) => { if (context.warn) context.warn(code, message, details); };
  if (analyzeDynamicScope(ast, { context }).hasAny) return result;
  const scopes = [];
  traverse(ast, { Program(path) { scopes.push(path); }, BlockStatement(path) { if (path.parentPath.isFunction()) scopes.push(path); } });
  for (const parent of scopes.reverse()) {
    if (!parent.node || parent.removed) continue;
    const data = scopeData(parent);
    for (const record of data.calls) {
      if (!record.child.path.node || record.child.path.removed || !record.base.path.node || record.base.path.removed) continue;
      const candidate = analyze(record, parent, data);
      if (candidate.skip) { result.skipped.push({ name: record.child.identifier.name, line: record.path.node.loc && record.path.node.loc.start.line, reason: candidate.skip, engine: 'babel-inheritance' }); continue; }
      let parentClass, childClass;
      try { parentClass = classDeclaration(candidate, record.base); childClass = classDeclaration(candidate, record.child, record.base); }
      catch (error) { result.skipped.push({ name: record.child.identifier.name, reason: `class syntax rejected inheritance: ${error.message}`, engine: 'babel-inheritance' }); continue; }
      const originalArgs = record.path.node.arguments.filter(argument => t.isAssignmentExpression(argument, { operator: '=' })).map(argument => t.expressionStatement(t.cloneNode(argument, true)));
      const records = [record.base, record.child].map(binding => ({ name: binding.identifier.name, line: binding.path.node.loc && binding.path.node.loc.start.line, placementLine: (sourceLoc(parent.get('body')[binding === record.base ? candidate.baseAnchor : candidate.childAnchor]) || sourceLoc(binding.path))?.start.line, methods: candidate.methods.filter(method => method.owner === binding).length, staticMethods: candidate.statics.filter(method => method.owner === binding).length, aliases: [...data.events].filter(([alias, events]) => alias !== binding && events.some(event => event.value === binding)).map(([alias]) => alias.identifier.name), assumptions: ['class bodies use strict mode and constructors require new', 'class prototype methods and constructor properties become non-enumerable; methods are non-constructible', 'the canonical ES5 helper is replaced with standard class static/prototype inheritance', 'external consumers of constructor aliases must use new'], engine: 'babel-inheritance' }));
      const baseAnchor = parent.get('body')[candidate.baseAnchor], childAnchor = record.path.parentPath;
      record.base.scope.removeBinding(record.base.identifier.name); record.child.scope.removeBinding(record.child.identifier.name);
      baseAnchor.insertBefore(parentClass);
      const inserted = childAnchor.insertBefore([childClass, ...originalArgs]);
      for (const method of [...candidate.methods, ...candidate.statics]) if (method.statement.node && !method.statement.removed) method.statement.remove();
      candidate.basePath.remove(); candidate.childPath.remove(); candidate.bridge.path.remove();
      candidate.statement.remove(); childAnchor.remove();
      cleanupAliases(ast, inserted.filter(path => path.isExpressionStatement()));
      const names = new Set([...candidate.aliases].map(binding => binding.identifier.name));
      for (const name of names) {
        const binding = parent.scope.getBinding(name);
        if (binding && binding.path.isVariableDeclarator() && !binding.referenced && !binding.constantViolations.length && !binding.path.node.init) removeDeclaration(binding.path);
      }
      const helper = parent.scope.getBinding(record.helper.identifier.name), helperPath = helper && functionPath(helper);
      if (helper && helperPath && helper.referencePaths.every(reference => inside(reference, helperPath))) removeDeclaration(helper.path);
      result.converted.push(...records); result.changes += 2;
      for (const item of records) warn('CLASS_INHERITANCE_ASSUMPTIONS', `Modernized canonical ES5 inheritance for ${item.name}.`, item);
      // Bindings and paths must be rediscovered before another shared family.
      break;
    }
  }
  if (result.skipped.length) warn('CLASS_INHERITANCE_SKIPPED', 'Some inheritance installations were retained because the canonical family could not be proved.', { skipped: result.skipped });
  return result;
}

module.exports = { modernizeInheritance };
