'use strict';

const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const { t, traverse, evaluate, UNKNOWN, propertyName, isWrite, isPublic, analyzeDynamicScope } = require('../passes/_utils');
const { dominates } = require('../passes/_dispatch');

function owner(path) { return path.getFunctionParent(); }
function statement(path, parent) {
  let child = path;
  while (child && child.parentPath !== parent) child = child.parentPath;
  return child && child.inList && child.listKey === 'body' ? child : null;
}
function inside(path, ancestor) {
  for (let current = path; current; current = current.parentPath) if (current === ancestor) return true;
  return false;
}
function sourceLoc(path) {
  if (path.node.loc) return path.node.loc;
  let loc;
  t.traverseFast(path.node, node => { if (!loc && node.loc) loc = node.loc; });
  return loc;
}
function position(path, parent) {
  const child = statement(path, parent);
  return child ? child.key : null;
}
function hazard(node) {
  let reason = null;
  t.traverseFast(node, value => {
    if (t.isWithStatement(value)) reason = 'with in constructor or method';
    if (t.isCallExpression(value) && t.isIdentifier(value.callee, { name: 'eval' })) reason = 'direct eval in constructor or method';
    if (t.isMemberExpression(value) && t.isIdentifier(value.object, { name: 'arguments' }) && ['callee', 'caller'].includes(propertyName(value))) reason = 'arguments.callee/caller in constructor or method';
    if (t.isMetaProperty(value) || t.isSuper(value)) reason = 'new.target or super requires a dedicated transformation';
  });
  return reason;
}
function resultUse(path) {
  let current = path;
  while (current.parentPath) {
    const parent = current.parentPath;
    if (parent.isConditionalExpression() && current.key !== 'test' || parent.isLogicalExpression() || parent.isSequenceExpression() && current.key === parent.node.expressions.length - 1 || parent.isAssignmentExpression({ operator: '=' }) && current.key === 'right' || parent.isParenthesizedExpression()) current = parent;
    else break;
  }
  return current;
}
function methodConstructed(path, active = new Set()) {
  const value = resultUse(path), parent = value.parentPath;
  if (parent.isNewExpression() && value.key === 'callee') return true;
  if (parent.isMemberExpression() && value.key === 'object' && ['prototype', 'bind'].includes(propertyName(parent.node))) return true;
  if (parent.isCallExpression() && parent.get('callee').isMemberExpression() && propertyName(parent.node.callee) === 'construct' && value.listKey === 'arguments' && value.key === 0) return true;
  if (parent.isVariableDeclarator() && value.key === 'init' && t.isIdentifier(parent.node.id)) {
    const binding = parent.scope.getBinding(parent.node.id.name);
    if (!binding || !binding.constant || binding.constantViolations.length || active.has(binding)) return true;
    active.add(binding);
    const result = binding.referencePaths.some(reference => methodConstructed(reference, active));
    active.delete(binding);
    return result;
  }
  return false;
}
function validMethod(fn) {
  const issue = hazard(fn.node);
  if (issue) return issue;
  if (fn.node.id) {
    const self = fn.scope.getBinding(fn.node.id.name);
    if (self && self.referenced) return 'named method expression uses its private recursive binding';
  }
  return null;
}

function closureContainer(closure) {
  if (!closure.isFunctionExpression() && !closure.isArrowFunctionExpression()) return null;
  const assignment = closure.parentPath;
  if (!assignment.isAssignmentExpression({ operator: '=' }) || closure.key !== 'right') return null;
  let receiver = assignment.get('left');
  if (!receiver.isMemberExpression()) return null;
  receiver = receiver.get('object');
  if (receiver.isMemberExpression() && propertyName(receiver.node) === 'prototype') receiver = receiver.get('object');
  return receiver.isIdentifier() ? receiver.scope.getBinding(receiver.node.name) : null;
}

// A method closure may be created before another class is initialized while
// remaining unreachable until later. Check the private container's complete
// alias/reference graph, rather than treating textual closure creation as a
// possible invocation. Internal mutually-recursive methods are checked
// coinductively; every external root still needs an after-initialization proof.
function deferredAfter(point, reference, active = new Set()) {
  if (dominates(point, reference)) return true;
  const enclosing = owner(point);
  let closure = owner(reference);
  if (!closure || closure === enclosing) return false;
  while (owner(closure) && owner(closure) !== enclosing) closure = owner(closure);
  if (owner(closure) !== enclosing) return false;
  if (closure.isFunctionDeclaration() && closure.node.id) return privateContainerAfter(point, closure.parentPath.scope.getBinding(closure.node.id.name), active);
  if ((closure.isFunctionExpression() || closure.isArrowFunctionExpression()) && closure.parentPath.isVariableDeclarator() && t.isIdentifier(closure.parentPath.node.id)) return privateContainerAfter(point, closure.parentPath.scope.getBinding(closure.parentPath.node.id.name), active);
  const container = closureContainer(closure);
  return !!container && privateContainerAfter(point, container, active);
}

function privateContainerAfter(point, binding, active) {
  if (!binding || !binding.constant || binding.constantViolations.length || isPublic(binding)) return false;
  if (active.has(binding)) return true;
  if (!binding.path.isFunctionDeclaration() && !(binding.path.isVariableDeclarator() && (t.isIdentifier(binding.path.node.init) || t.isFunctionExpression(binding.path.node.init) || t.isArrowFunctionExpression(binding.path.node.init)))) return false;
  active.add(binding);
  let safe = true;
  for (const reference of binding.referencePaths) {
    if (binding.path.isFunctionDeclaration() && inside(reference, binding.path)) continue;
    if (binding.path.isVariableDeclarator() && (t.isFunctionExpression(binding.path.node.init) || t.isArrowFunctionExpression(binding.path.node.init)) && inside(reference, binding.path.get('init'))) continue;
    const parent = reference.parentPath;
    if (parent.isVariableDeclarator() && reference.key === 'init' && t.isIdentifier(parent.node.id)) {
      if (!privateContainerAfter(point, parent.scope.getBinding(parent.node.id.name), active)) { safe = false; break; }
      continue;
    }
    if (parent.isMemberExpression() && reference.key === 'object') {
      let member = parent;
      if (propertyName(member.node) === 'prototype') {
        if (isWrite(member) || !member.parentPath.isMemberExpression() || member.key !== 'object') { safe = false; break; }
        member = member.parentPath;
      }
      const assignment = member.parentPath;
      if (isWrite(member) && assignment.isAssignmentExpression({ operator: '=' }) && member.key === 'left' && assignment.get('right').isFunctionExpression() && assignment.parentPath.isExpressionStatement() && owner(assignment) === owner(point)) continue;
      if (deferredAfter(point, reference, active)) continue;
      safe = false; break;
    }
    if (!deferredAfter(point, reference, active)) { safe = false; break; }
  }
  active.delete(binding);
  return safe;
}

function analyze(path) {
  const name = path.node.id.name;
  const parent = path.parentPath;
  const binding = parent.scope.getBinding(name);
  const candidate = { path, name, parent, binding, methods: [], statics: [], runtimeInstallations: [], aliases: new Set([name]), aliasStatements: new Set(), escaped: false, skip: null };
  const fail = reason => { if (!candidate.skip) candidate.skip = reason; };
  if (path.node.async || path.node.generator || !binding || !binding.constant || binding.constantViolations.length) { fail('constructor is asynchronous, a generator, or reassigned'); return candidate; }
  if (hazard(path.node)) { fail(hazard(path.node)); return candidate; }
  const versions = [{ binding, start: null }], visited = new Map();
  const exposures = [], knownMembers = [], prototypeUses = [];
  while (versions.length && !candidate.skip) {
    const version = versions.shift();
    const seen = visited.get(version.binding) || new Set();
    const token = version.start ? version.start.node : null;
    if (seen.has(token)) continue;
    seen.add(token); visited.set(version.binding, seen);
    candidate.aliases.add(version.binding.identifier.name);
    const startIndex = version.start ? position(version.start, parent) : null;
    const writes = version.binding.constantViolations.filter(write => !version.start || write.node !== version.start.node && !inside(version.start, write));
    for (const reference of version.binding.referencePaths) {
      // Mutable aliases are followed by assignment version. An earlier flat
      // statement cannot use a value only assigned to the alias later.
      const index = position(reference, parent);
      if (version.start && owner(reference) === owner(path) && startIndex !== null && index !== null && index < startIndex) continue;
      const intervening = writes.find(write => {
        const at = position(write, parent);
        return owner(reference) === owner(path) && at !== null && index !== null && at < index && (startIndex === null || at > startIndex);
      });
      if (intervening) continue;
      const direct = reference.parentPath;
      const value = resultUse(reference), valueParent = value.parentPath;
      if ((valueParent.isCallExpression() || valueParent.isOptionalCallExpression()) && value.key === 'callee' || valueParent.isTaggedTemplateExpression() && value.key === 'tag') { fail('constructor or alias is called without new'); break; }
      if (direct.isVariableDeclarator() && reference.key === 'init' && t.isIdentifier(direct.node.id)) {
        const alias = direct.scope.getBinding(direct.node.id.name);
        if (!alias) { fail('unresolved constructor alias'); break; }
        versions.push({ binding: alias, start: direct });
        if (owner(direct) === owner(path)) candidate.aliasStatements.add(direct.parentPath.node);
        continue;
      }
      if (direct.isAssignmentExpression({ operator: '=' }) && reference.key === 'right') {
        let assignment = direct;
        while (assignment && assignment.isAssignmentExpression({ operator: '=' })) {
          if (t.isIdentifier(assignment.node.left)) {
            const alias = assignment.scope.getBinding(assignment.node.left.name);
            if (!alias) { candidate.escaped = true; exposures.push(reference); break; }
            versions.push({ binding: alias, start: assignment });
          } else { candidate.escaped = true; exposures.push(reference); break; }
          assignment = assignment.parentPath.isAssignmentExpression({ operator: '=' }) && assignment.key === 'right' ? assignment.parentPath : null;
        }
        continue;
      }
      if ((direct.isCallExpression() || direct.isOptionalCallExpression()) && reference.key === 'callee' || direct.isTaggedTemplateExpression() && reference.key === 'tag') { fail('constructor or alias is called without new'); break; }
      if ((direct.isCallExpression() || direct.isOptionalCallExpression() || direct.isNewExpression()) && reference.listKey === 'arguments') {
        fail('constructor is passed to an unknown call that may implement inheritance or mutate its prototype');
        break;
      }
      if (direct.isMemberExpression() && reference.key === 'object') {
        const key = propertyName(direct.node);
        if (['call', 'apply', 'bind', 'caller', 'arguments'].includes(key)) { fail(`constructor or alias uses .${key}`); break; }
        if (key === 'prototype') {
          if (isWrite(direct)) { fail('dynamic prototype replacement'); break; }
          const member = direct.parentPath;
          if (!member.isMemberExpression() || direct.key !== 'object') { fail('prototype escapes or participates in unknown inheritance/descriptor setup'); break; }
          const methodName = propertyName(member.node);
          if (methodName === null || ['constructor', '__proto__'].includes(methodName)) { fail('dynamic or special prototype property'); break; }
          const assignment = member.parentPath;
          if (isWrite(member)) {
            if (!assignment.isAssignmentExpression({ operator: '=' }) || member.key !== 'left') { fail('prototype method is updated or deleted dynamically'); break; }
            if (assignment.get('right').isFunctionExpression()) {
              if (!assignment.parentPath.isExpressionStatement() || assignment.parentPath.parentPath !== parent) {
                const container = statement(assignment, parent);
                if (owner(assignment) !== owner(path) || !container) { fail('prototype function assignment is in another execution scope'); break; }
                // Keep runtime selection exactly where it was. These functions
                // remain ordinary constructible function expressions and are
                // deliberately not reported as converted class methods.
                candidate.runtimeInstallations.push({ name: methodName, assignment, statement: container });
                continue;
              }
              const fn = assignment.get('right');
              const invalid = validMethod(fn);
              if (invalid) { fail(invalid); break; }
              candidate.methods.push({ name: methodName, fn, statement: assignment.parentPath, static: false });
            } else {
              // Numeric/string prototype fields are retained in place. Class
              // conversion does not require turning these into instance fields.
              if (owner(member) === owner(path)) exposures.push(reference);
            }
          } else {
            if (methodConstructed(member)) { fail('a prototype method is used as a constructor or its constructibility is observed'); break; }
            prototypeUses.push({ member, reference });
          }
          knownMembers.push(direct.node);
          continue;
        }
        const assignment = direct.parentPath;
        if (isWrite(direct) && assignment.isAssignmentExpression({ operator: '=' }) && direct.key === 'left' && assignment.get('right').isFunctionExpression()) {
          if (['name', 'length', 'prototype', 'caller', 'arguments', '__proto__'].includes(key) || key === null) { fail('static function uses a special constructor property'); break; }
          if (!assignment.parentPath.isExpressionStatement() || assignment.parentPath.parentPath !== parent) { fail('static function assignment is conditional, embedded, or in another scope'); break; }
          const fn = assignment.get('right');
          const invalid = validMethod(fn);
          if (invalid) { fail(invalid); break; }
          candidate.statics.push({ name: key, fn, statement: assignment.parentPath, static: true });
        } else {
          if (!isWrite(direct) && methodConstructed(direct)) { fail('a static method is used as a constructor or its constructibility is observed'); break; }
          exposures.push(reference);
        }
        continue;
      }
      if (direct.isNewExpression() && reference.key === 'callee') { exposures.push(reference); continue; }
      // Unknown external consumers are an explicit opt-in assumption, not a
      // proof that ordinary calls can never happen outside this input.
      candidate.escaped = true;
      exposures.push(reference);
    }
  }
  // Aliases can yield the same assignment through multiple versions.
  candidate.methods = [...new Map(candidate.methods.map(method => [method.statement.node, method])).values()];
  candidate.statics = [...new Map(candidate.statics.map(method => [method.statement.node, method])).values()];
  candidate.runtimeInstallations = [...new Map(candidate.runtimeInstallations.map(method => [method.assignment.node, method])).values()];
  if (candidate.skip || !candidate.methods.length) return candidate;
  for (const methods of [candidate.methods, candidate.statics]) {
    if (new Set(methods.map(method => method.name)).size !== methods.length) { fail('a method is assigned more than once'); return candidate; }
  }
  const all = [...candidate.methods, ...candidate.statics];
  const statementNodes = new Set(all.map(method => method.statement.node));
  const last = all.reduce((a, b) => a.statement.key > b.statement.key ? a : b).statement;
  for (const installation of candidate.runtimeInstallations) if (installation.statement.key <= last.key) { fail('runtime prototype installation interleaves ordinary method initialization'); return candidate; }
  const owned = new Set([path.node, ...all.map(method => method.fn.node)]);
  for (const exposure of [...exposures, ...prototypeUses.map(use => use.reference)]) {
    if (inside(exposure, path) || all.some(method => inside(exposure, method.fn))) continue;
    if (!dominates(last, exposure, owned) && !deferredAfter(last, exposure)) { fail('constructor/prototype is observed or can be invoked before all methods are installed'); return candidate; }
  }
  let firstIndex = Math.min(path.key, ...all.map(method => method.statement.key));
  for (const declaration of candidate.aliasStatements) {
    const alias = parent.get('body').find(sibling => sibling.node === declaration);
    if (alias) firstIndex = Math.min(firstIndex, alias.key);
  }
  const siblings = parent.get('body');
  for (let i = firstIndex; i <= last.key; i++) {
    const current = siblings[i];
    if (current === path || current.isFunctionDeclaration() || current.isEmptyStatement() || statementNodes.has(current.node)) continue;
    if (current.isVariableDeclaration() && current.node.declarations.every(declaration => !declaration.init || evaluate(declaration.init) !== UNKNOWN || t.isFunctionExpression(declaration.init) || t.isArrowFunctionExpression(declaration.init) || candidate.aliasStatements.has(current.node) && t.isIdentifier(declaration.init))) continue;
    fail('executable statements between constructor placement and method installation may observe partial initialization'); return candidate;
  }
  // Descriptor and prototype mutation through global Function/Object objects
  // cannot be treated as an ordinary class installation.
  let specialGlobalMutation = false;
  const program = path.findParent(node => node.isProgram());
  program.traverse({ MemberExpression(member) {
    if (propertyName(member.node) === 'prototype' && t.isIdentifier(member.node.object, { name: 'Object' })) {
      const up = member.parentPath;
      if (!up.isMemberExpression() || isWrite(up)) specialGlobalMutation = true;
    }
    if (binding.scope.path.isProgram() && ['globalThis', 'window', 'global'].some(global => t.isIdentifier(member.node.object, { name: global })) && candidate.aliases.has(propertyName(member.node)) && isWrite(member)) specialGlobalMutation = true;
  } });
  if (specialGlobalMutation) { fail('explicit global constructor or Object.prototype mutation'); return candidate; }
  candidate.anchor = siblings[firstIndex];
  return candidate;
}

function lebabClass(candidate) {
  const lebab = require('lebab');
  // Lebab's collector is order-sensitive and name-based. Feed one normalized
  // binding at a time, with its constructor first, never the whole input.
  const ctor = t.cloneNode(candidate.path.node, true);
  const methods = [...candidate.methods, ...candidate.statics];
  const statements = [ctor, ...methods.map(method => t.expressionStatement(t.assignmentExpression('=', t.memberExpression(method.static ? t.identifier(candidate.name) : t.memberExpression(t.identifier(candidate.name), t.identifier('prototype')), t.identifier(method.name)), t.cloneNode(method.fn.node, true))))];
  const code = generate(t.file(t.program(statements)), { comments: false }).code;
  const result = lebab.transform(code, ['class']);
  const parsed = parser.parse(result.code, { sourceType: 'script' });
  const converted = parsed.program.body.find(node => t.isClassDeclaration(node) && node.id && node.id.name === candidate.name);
  if (!converted) throw new Error('Lebab did not produce the expected class');
  const expected = new Set(methods.map(method => `${method.static}:${method.name}`));
  for (const method of converted.body.body) if (method.kind !== 'constructor') expected.delete(`${method.static}:${method.key.name || method.key.value}`);
  if (expected.size || converted.superClass) throw new Error('Lebab class does not match the selected method set');
  // Lebab's output supplies the class transformation. Restore original Babel
  // subtrees and locations instead of retaining generated-fragment positions.
  const body = [t.classMethod('constructor', t.identifier('constructor'), candidate.path.node.params.map(node => t.cloneNode(node, true)), t.cloneNode(candidate.path.node.body, true))];
  body[0].loc = candidate.path.node.loc;
  for (const method of methods) {
    const original = method.fn.node;
    const node = t.classMethod('method', t.identifier(method.name), original.params.map(param => t.cloneNode(param, true)), t.cloneNode(original.body, true), false, method.static);
    node.async = original.async;
    node.generator = original.generator;
    node.loc = original.loc;
    t.inheritsComments(node, method.statement.node);
    body.push(node);
  }
  const declaration = t.classDeclaration(t.identifier(candidate.name), null, t.classBody(body));
  declaration.loc = sourceLoc(candidate.anchor);
  declaration.id.loc = candidate.path.node.id.loc;
  t.inheritsComments(declaration, candidate.path.node);
  // Class strictness can make previously valid function syntax illegal.
  parser.parse(generate(declaration).code, { sourceType: 'script' });
  return declaration;
}

function modernizeClasses(ast, context = {}) {
  const result = { changes: 0, tool: { name: 'lebab', version: '3.2.9' }, converted: [], skipped: [] };
  const warn = (code, message, details) => { if (typeof context.warn === 'function') context.warn(code, message, details); };
  const dynamic = analyzeDynamicScope(ast, { context });
  const paths = [];
  traverse(ast, { FunctionDeclaration(path) {
    if (path.node.id && path.inList && path.listKey === 'body' && (path.parentPath.isProgram() || path.parentPath.isBlockStatement() && path.parentPath.parentPath.isFunction())) paths.push(path);
  } });
  // Limit skip reporting to families with actual prototype/static evidence;
  // a helper merely being called ordinarily is not a failed class candidate.
  const evidence = new Set();
  function origins(binding, visited = new Set()) {
    if (!binding || visited.has(binding)) return;
    visited.add(binding);
    if (binding.path.isFunctionDeclaration()) { evidence.add(binding); return; }
    function follow(node, scope) {
      while (t.isAssignmentExpression(node, { operator: '=' })) node = node.right;
      if (t.isIdentifier(node)) origins(scope.getBinding(node.name), visited);
    }
    if (binding.path.isVariableDeclarator()) follow(binding.path.node.init, binding.path.scope);
    for (const write of binding.constantViolations) if (write.isAssignmentExpression({ operator: '=' })) follow(write.node.right, write.scope);
  }
  traverse(ast, { MemberExpression(path) {
    if (!t.isIdentifier(path.node.object)) return;
    if (propertyName(path.node) === 'prototype' || path.parentPath.isAssignmentExpression({ operator: '=' }) && path.key === 'left' && path.parentPath.get('right').isFunctionExpression()) origins(path.scope.getBinding(path.node.object.name));
  } });
  const candidates = paths.map(path => analyze(path));
  // Children must be rewritten before an outer method/constructor body is
  // cloned, otherwise subsequent paths refer to the discarded original body.
  for (const candidate of candidates.reverse()) {
    if (!evidence.has(candidate.binding)) continue;
    if (!candidate.methods.length && !candidate.skip) continue;
    if (!candidate.skip && (dynamic.affectsBinding(candidate.binding) || dynamic.affectsRegion(candidate.path))) candidate.skip = 'direct eval or with prevents reliable class binding/strictness analysis';
    if (candidate.skip) {
      if (candidate.methods.length || candidate.skip.includes('prototype') || candidate.skip.includes('constructor')) result.skipped.push({ name: candidate.name, line: candidate.path.node.loc && candidate.path.node.loc.start.line, reason: candidate.skip });
      continue;
    }
    let declaration;
    try {
      declaration = lebabClass(candidate);
    } catch (error) {
      result.skipped.push({ name: candidate.name, line: candidate.path.node.loc && candidate.path.node.loc.start.line, reason: `Lebab/class syntax rejected candidate: ${error.message}` });
      continue;
    }
    // After preparation succeeds, mutation failures must propagate to the
    // engine's PASS_ERROR boundary. They must never masquerade as a safe skip.
    const record = {
        name: candidate.name,
        line: candidate.path.node.loc && candidate.path.node.loc.start.line,
        placementLine: sourceLoc(candidate.anchor) && sourceLoc(candidate.anchor).start.line,
        methods: candidate.methods.length,
        staticMethods: candidate.statics.length,
        runtimeInstallationsRetained: candidate.runtimeInstallations.length,
        runtimeInstallations: candidate.runtimeInstallations.map(installation => ({ name: installation.name, line: sourceLoc(installation.assignment) && sourceLoc(installation.assignment).start.line })),
        aliases: [...candidate.aliases].filter(name => name !== candidate.name),
        assumptions: ['prototype methods become non-enumerable and non-constructible', 'constructors require new and class bodies use strict mode', 'class bindings have lexical initialization and may differ from public function globals', ...(candidate.escaped ? ['external consumers of the exported/escaped constructor must use new'] : [])],
    };
    const anchor = candidate.anchor;
    const removed = new Set([candidate.path, ...candidate.methods.map(method => method.statement), ...candidate.statics.map(method => method.statement)]);
    // Replacing a hoisted function with a lexical class at the same path
    // otherwise trips Babel's old binding registration after mutating the AST.
    candidate.binding.scope.removeBinding(candidate.name);
    for (const path of removed) if (path !== anchor && path.node && !path.removed) path.remove();
    if (removed.has(anchor)) anchor.replaceWith(declaration);
    else anchor.insertBefore(declaration);
    const runtimeStatements = new Set(candidate.runtimeInstallations.map(installation => installation.statement.node));
    for (const runtime of runtimeStatements) {
      const names = [...new Set(candidate.runtimeInstallations.filter(installation => installation.statement.node === runtime).map(installation => installation.name))];
      t.addComment(runtime, 'leading', ` Runtime-selected prototype method(s) for ${candidate.name}: ${names.join(', ')}. Kept here to preserve initialization order. `);
    }
    result.converted.push(record);
    result.changes++;
    warn('CLASS_BEHAVIOR_ASSUMPTIONS', `Modernized ${candidate.name} with Lebab under opt-in class behavior assumptions.`, record);
  }
  if (result.skipped.length) warn('CLASS_CANDIDATES_SKIPPED', 'Some constructor families retained their original function/prototype representation.', { skipped: result.skipped });
  if (context.state instanceof Map) context.state.set('class-modernization', result);
  return result;
}

module.exports = { modernizeClasses };
