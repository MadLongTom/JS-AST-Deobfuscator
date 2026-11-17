'use strict';

const t = require('@babel/types');

const GLOBALS = new Set(['globalThis', 'window', 'self', 'global']);
const ROOTS = new Set(['String', 'RegExp', 'Number', 'Object', 'Reflect']);
const PROTECTED = { String: new Set(['replace', 'slice', 'charCodeAt']), Number: new Set(['toString']) };
const MUTATORS = new Set(['defineProperty', 'defineProperties', 'assign', 'setPrototypeOf', 'set', 'deleteProperty', 'freeze', 'seal', 'preventExtensions']);

// A deliberately small symbolic alias analysis. It does not execute any source
// expression. resolveString must prove an effect-free static string value.
function jsonIntrinsicHazard(programPath, resolveString = () => undefined, onHazard) {
  let hazardous = false;
  const mark = (path, reason) => {
    hazardous = true;
    const reasons = reported.get(path.node) || new Set();
    if (reasons.has(reason)) return;
    reasons.add(reason); reported.set(path.node, reasons);
    if (typeof onHazard === 'function') onHazard({ path, reason });
    else if (onHazard && typeof onHazard.onHazard === 'function') onHazard.onHazard(path, reason);
  };
  const bindings = new Map(), resolving = new Set(), tainted = new Set(), keyProofMethods = new Set(), writes = [], calls = [], reported = new Map();
  const root = (name, parts = []) => ({ kind: 'root', root: name, parts });
  function staticString(path, active = new Set()) {
    if (path.isStringLiteral()) return path.node.value;
    const resolved = resolveString(path);
    if (typeof resolved === 'string') return resolved.length <= 512 ? resolved : undefined;
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding || !binding.constant || binding.constantViolations.length || active.has(binding) || !binding.path.isVariableDeclarator() || !binding.path.node.init) return;
      const next = new Set(active); next.add(binding);
      return staticString(binding.path.get('init'), next);
    }
    if (path.isBinaryExpression({ operator: '+' })) {
      const left = staticString(path.get('left'), active), right = staticString(path.get('right'), active);
      if (left !== undefined && right !== undefined && left.length + right.length <= 512) return left + right;
    }
    if (!path.isCallExpression() || path.node.optional || !path.get('callee').isMemberExpression()) return;
    const callee = path.get('callee'), input = staticString(callee.get('object'), active);
    if (input === undefined) return;
    const method = callee.node.computed ? staticString(callee.get('property'), active) : callee.node.property.name;
    if (method === 'toLowerCase' && path.node.arguments.length === 0) {
      keyProofMethods.add('toLowerCase');
      return input.toLowerCase();
    }
    if (method === 'replace' && path.node.arguments.length === 2) {
      const pattern = path.get('arguments.0'), replacement = staticString(path.get('arguments.1'), active);
      if (pattern.isRegExpLiteral() && pattern.node.pattern === '[^a-zA-Z0-9$]' && pattern.node.flags === 'g' && replacement === '') return input.replace(/[^a-zA-Z0-9$]/g, '');
    }
  }
  const key = path => {
    if (path.isStringLiteral() || path.isNumericLiteral()) return String(path.node.value);
    if (path.isMemberExpression() && !path.node.computed && path.get('object').isIdentifier({ name: 'Symbol' }) && !path.scope.getBinding('Symbol')) return '@@' + path.node.property.name;
    const value = staticString(path);
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '?';
  };
  const memberKey = path => path.node.computed ? key(path.get('property')) : path.get('property').isIdentifier() ? path.node.property.name : '?';
  const isFamily = value => value && value.kind === 'root' && ['String', 'RegExp', 'Number'].includes(value.root);
  const isPrototype = value => isFamily(value) && (value.parts[0] === 'prototype' || value.parts[0] === '__proto__' || value.parts.includes('?'));
  const prototypeValue = value => isPrototype(value) && (value.parts.includes('?') || value.parts.every((part, index) => index === 0 || part === '__proto__'));
  const sensitiveValue = value => !!value && (prototypeValue(value) || isFamily(value) && value.parts.length === 0 || value.kind === 'derived-sensitive' && sensitiveValue(value.target) || value.kind === 'bound' && value.args.some(argument => sensitiveValue(resolve(argument))));
  const property = (value, name) => {
    if (!value) return null;
    if (value.kind === 'bound' || value.kind === 'derived-sensitive') return { kind: 'derived-sensitive', target: value };
    if (value.kind === 'instance') {
      if (name === '__proto__') return root(value.root, ['prototype']);
      if (name === 'constructor') return root(value.root);
      return null;
    }
    if (value.kind !== 'root') return null;
    if (value.root === 'global' && !value.parts.length) {
      if (GLOBALS.has(name)) return root('global');
      if (ROOTS.has(name)) return root(name);
    }
    return root(value.root, [...value.parts, name]);
  };
  const functionOperation = value => {
    if (!value || value.kind !== 'root' || !['Object', 'Reflect'].includes(value.root) || value.parts.length !== 1) return null;
    return MUTATORS.has(value.parts[0]) || value.parts[0] === 'getPrototypeOf' ? { root: value.root, name: value.parts[0] } : null;
  };
  function resolveBinding(binding) {
    if (!binding || !binding.constant || binding.constantViolations.length || resolving.has(binding)) return null;
    if (bindings.has(binding)) return bindings.get(binding);
    resolving.add(binding);
    let value = null;
    const declaration = binding.path;
    if (declaration.isVariableDeclarator() && declaration.node.init) {
      value = resolve(declaration.get('init'));
      if (!declaration.get('id').isIdentifier()) {
        const pattern = declaration.get('id');
        if (pattern.isObjectPattern()) {
          const entry = pattern.get('properties').find(item => item.isObjectProperty() && item.get('value').isIdentifier() && item.node.value === binding.identifier);
          value = entry ? property(value, entry.node.computed ? key(entry.get('key')) : entry.get('key').isIdentifier() ? entry.node.key.name : key(entry.get('key'))) : null;
        } else value = null;
      }
    }
    resolving.delete(binding); bindings.set(binding, value);
    return value;
  }
  function resolve(path) {
    if (!path || !path.node) return null;
    if (path.isParenthesizedExpression()) return resolve(path.get('expression'));
    if (path.isSequenceExpression()) return resolve(path.get('expressions').at(-1));
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (binding) return resolveBinding(binding);
      if (GLOBALS.has(path.node.name)) return root('global');
      return ROOTS.has(path.node.name) ? root(path.node.name) : null;
    }
    if (path.isStringLiteral()) return { kind: 'instance', root: 'String' };
    if (path.isNumericLiteral()) return { kind: 'instance', root: 'Number' };
    if (path.isRegExpLiteral()) return { kind: 'instance', root: 'RegExp' };
    if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
      const object = resolve(path.get('object'));
      return object ? property(object, memberKey(path)) : null;
    }
    if (path.isNewExpression()) {
      const value = resolve(path.get('callee'));
      return isFamily(value) && !value.parts.length ? { kind: 'instance', root: value.root } : null;
    }
    if (path.isCallExpression() && !path.node.optional) {
      const callee = path.get('callee');
      if (callee.isMemberExpression() && memberKey(callee) === 'bind') {
        const target = resolve(callee.get('object'));
        if (functionOperation(target) && path.node.arguments.every(argument => !t.isSpreadElement(argument))) return { kind: 'bound', target, args: path.get('arguments').slice(1) };
      }
      const op = functionOperation(resolve(callee));
      if (op && op.name === 'getPrototypeOf' && path.node.arguments.length === 1) {
        const argument = resolve(path.get('arguments.0'));
        if (argument && argument.kind === 'instance') return root(argument.root, ['prototype']);
        if (isFamily(argument)) return property(argument, '__proto__');
      }
      const operation = invocation(path);
      if (operation && operation.root === 'Object' && ['defineProperty', 'defineProperties', 'assign', 'setPrototypeOf', 'freeze', 'seal', 'preventExtensions'].includes(operation.name)) return resolve(operation.args[0]);
    }
    return null;
  }
  function writeHazard(value) {
    if (!value || value.kind !== 'root') return false;
    if (value.root === 'global') return value.parts.length === 0 || value.parts[0] === '?';
    if (!isFamily(value)) return false;
    const parts = value.parts;
    if (!parts.length || ['?', '__proto__'].includes(parts[0])) return true;
    if (parts[0] !== 'prototype') return false;
    if (parts.length === 1 || value.root === 'RegExp') return true;
    return ['?', '__proto__'].includes(parts[1]) || PROTECTED[value.root].has(parts[1]) || value.root === 'String' && keyProofMethods.has(parts[1]);
  }
  const targetKeyHazard = (target, name) => writeHazard(property(target, name));
  const namedProperties = path => {
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding || !binding.constant || binding.constantViolations.length || !binding.path.isVariableDeclarator() || !binding.path.node.init) return null;
      path = binding.path.get('init');
    }
    if (!path.isObjectExpression()) return null;
    const result = [];
    for (const item of path.get('properties')) {
      if (!item.isObjectProperty() && !item.isObjectMethod()) return null;
      result.push(item.node.computed ? key(item.get('key')) : item.get('key').isIdentifier() ? item.node.key.name : key(item.get('key')));
    }
    return result;
  };
  function objectExpression(path) {
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding || !binding.constant || binding.constantViolations.length || !binding.path.isVariableDeclarator() || !binding.path.node.init) return null;
      return objectExpression(binding.path.get('init'));
    }
    return path.isObjectExpression() ? path : null;
  }
  function dataDescriptor(path) {
    const names = namedProperties(path);
    return !!names && names.every(name => ['value', 'writable', 'enumerable', 'configurable'].includes(name));
  }
  function invocation(path) {
    let value = resolve(path.get('callee')), args = path.get('arguments');
    if (args.some(argument => argument.isSpreadElement())) return null;
    if (value && value.kind === 'bound') return { ...functionOperation(value.target), args: [...value.args, ...args] };
    if (value && value.kind === 'root' && ['call', 'apply'].includes(value.parts[value.parts.length - 1])) {
      const mode = value.parts[value.parts.length - 1];
      value = root(value.root, value.parts.slice(0, -1));
      const op = functionOperation(value);
      if (!op) return null;
      if (mode === 'call') return { ...op, args: args.slice(1) };
      if (args.length !== 2 || !args[1].isArrayExpression() || args[1].node.elements.some(element => !element || t.isSpreadElement(element))) return null;
      return { ...op, args: args[1].get('elements') };
    }
    const op = functionOperation(value);
    return op ? { ...op, args } : null;
  }
  function mutationHazard(call) {
    const op = invocation(call);
    if (!op || op.name === 'getPrototypeOf' || !op.args.length) return false;
    const target = resolve(op.args[0]);
    if (op.name === 'set' && op.args[3] && targetKeyHazard(resolve(op.args[3]), op.args[1] ? key(op.args[1]) : '?')) return true;
    if (!isFamily(target) || target.parts.length && !isPrototype(target)) return false;
    if (tainted.has(op.root) || tainted.has(op.root + '.' + op.name)) return true;
    if (op.name === 'defineProperty' || op.name === 'set' || op.name === 'deleteProperty') {
      if (op.args.length < 2 || targetKeyHazard(target, key(op.args[1]))) return true;
      if (op.name === 'defineProperty' && (!op.args[2] || !dataDescriptor(op.args[2]))) return true;
      return op.name === 'set' && op.args[3] && targetKeyHazard(resolve(op.args[3]), key(op.args[1]));
    }
    if (['defineProperties', 'assign'].includes(op.name)) {
      const sources = op.args.slice(1);
      if (!sources.length) return isPrototype(target);
      return sources.some(source => {
        const names = namedProperties(source);
        if (!names || names.some(name => targetKeyHazard(target, name))) return true;
        if (op.name !== 'defineProperties') return false;
        return objectExpression(source).get('properties').some(entry => !entry.isObjectProperty() || !dataDescriptor(entry.get('value')));
      });
    }
    return true;
  }
  function safeUse(path) {
    const parent = path.parentPath;
    if (!parent) return false;
    if (parent.isParenthesizedExpression()) return safeUse(parent);
    if (parent.isExpressionStatement() || parent.isUnaryExpression({ operator: 'void' })) return true;
    if (parent.isSequenceExpression()) return path.key < parent.node.expressions.length - 1 || safeUse(parent);
    if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && path.key === 'object') return true;
    if (parent.isVariableDeclarator() && path.key === 'init') {
      const ids = t.getBindingIdentifiers(parent.node.id);
      return Object.keys(ids).length > 0 && Object.keys(ids).every(name => !!resolveBinding(parent.scope.getBinding(name)));
    }
    if (parent.isUnaryExpression({ operator: 'typeof' }) || parent.isBinaryExpression() && ['===', '!=='].includes(parent.node.operator)) return true;
    if (parent.isArrayExpression() && parent.parentPath.isCallExpression()) {
      const op = invocation(parent.parentPath);
      if (op) return op.args[0] === path || op.name === 'set' && op.args[3] === path;
    }
    if (parent.isCallExpression() || parent.isNewExpression()) {
      if (path.key === 'callee') {
        const value = resolve(path);
        return isFamily(value) && !value.parts.length || parent.isCallExpression() && !!invocation(parent);
      }
      const op = parent.isCallExpression() && invocation(parent);
      if (op) {
        if (op.name === 'getPrototypeOf') return op.args[0] === path;
        return op.args[0] === path || op.name === 'set' && op.args[3] === path;
      }
      // An explicitly bound native mutator retains its target through a checked
      // constant alias. Calls/escapes of that bound function are checked later.
      const value = parent.isCallExpression() && resolve(parent);
      if (value && value.kind === 'bound' && value.args.includes(path)) return safeUse(parent);
    }
    return false;
  }
  function noValueFunction(path, active = new Set()) {
    if (path.isParenthesizedExpression()) return noValueFunction(path.get('expression'), active);
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding || !binding.constant || binding.constantViolations.length || active.has(binding)) return false;
      active.add(binding);
      if (binding.path.isFunctionDeclaration()) return noValueFunction(binding.path, active);
      return binding.path.isVariableDeclarator() && !!binding.path.node.init && noValueFunction(binding.path.get('init'), active);
    }
    if (!path.isFunction() || path.node.async || path.node.generator || !path.get('body').isBlockStatement()) return false;
    let returnsValue = false;
    path.traverse({ Function(inner) { inner.skip(); }, ReturnStatement(statement) { if (statement.node.argument) returnsValue = true; } });
    return !returnsValue;
  }
  function harmlessUnknownGlobalWrite(path, value) {
    if (!value || value.kind !== 'root' || value.root !== 'global' || value.parts.length !== 1 || value.parts[0] !== '?') return false;
    const assignment = path.parentPath;
    if (!assignment.isAssignmentExpression({ operator: '=' }) || path.key !== 'left') return false;
    const right = assignment.get('right');
    if (!right.isNullLiteral() && !noValueFunction(right)) return false;
    // Unknown global names may denote String, but replacing its constructor
    // with null/a function returning only undefined makes the parser throw
    // before its string.replace guard; it cannot enable a new eval grammar.
    // Such a write could also replace a mutation facade. Do not subsequently
    // trust Object/Reflect mutations of even an otherwise harmless leaf.
    tainted.add('Object'); tainted.add('Reflect');
    return true;
  }
  function namespace(path, active = new Set()) {
    const known = staticString(path);
    if (known !== undefined) return { prefix: known, suffix: known };
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding || !binding.constant || binding.constantViolations.length || active.has(binding) || !binding.path.isVariableDeclarator() || !binding.path.node.init) return null;
      const next = new Set(active); next.add(binding);
      return namespace(binding.path.get('init'), next);
    }
    if (!path.isBinaryExpression({ operator: '+' })) return null;
    const left = namespace(path.get('left'), active), right = namespace(path.get('right'), active);
    return left || right ? { prefix: left && left.prefix || '', suffix: right && right.suffix || '' } : null;
  }
  function namespaceGlobalWrite(path, value) {
    if (!value || value.kind !== 'root' || value.root !== 'global' || value.parts.length !== 1 || value.parts[0] !== '?' || !path.isMemberExpression() || !path.node.computed) return false;
    const constraint = namespace(path.get('property'));
    return !!constraint && [...ROOTS].every(name => constraint.prefix && !name.startsWith(constraint.prefix) || constraint.suffix && !name.endsWith(constraint.suffix));
  }
  function write(path) {
    if (path.isObjectPattern()) { for (const entry of path.get('properties')) write(entry.isRestElement() ? entry.get('argument') : entry.get('value')); return; }
    if (path.isArrayPattern()) { for (const entry of path.get('elements')) if (entry.node) write(entry); return; }
    if (path.isAssignmentPattern()) { write(path.get('left')); return; }
    if (path.isRestElement()) { write(path.get('argument')); return; }
    const value = resolve(path);
    writes.push({ path, value });
    if (value && value.kind === 'root' && ['Object', 'Reflect'].includes(value.root) && (!value.parts.length || value.parts.length === 1)) tainted.add(value.parts.length && value.parts[0] !== '?' ? value.root + '.' + value.parts[0] : value.root);
    if (writeHazard(value) && !harmlessUnknownGlobalWrite(path, value) && !namespaceGlobalWrite(path, value)) mark(path, 'protected-write');
  }
  // Collect native mutator replacement before interpreting any of its calls;
  // source order cannot make a later closure call safe to assume native.
  programPath.traverse({
    AssignmentExpression(path) { write(path.get('left')); },
    UpdateExpression(path) { write(path.get('argument')); },
    UnaryExpression(path) { if (path.node.operator === 'delete') write(path.get('argument')); },
    ForInStatement(path) { if (!path.get('left').isVariableDeclaration()) write(path.get('left')); },
    ForOfStatement(path) { if (!path.get('left').isVariableDeclaration()) write(path.get('left')); },
  });
  programPath.traverse({
    CallExpression(path) {
      calls.push(path);
      if (mutationHazard(path)) mark(path, 'intrinsic-mutator');
      const callee = resolve(path.get('callee'));
      if (isPrototype(callee) && callee.parts.length > 1) {
        const name = callee.parts[1];
        const known = callee.root === 'RegExp' ? ['test', 'exec', '@@replace'] : [...PROTECTED[callee.root]];
        if (!known.includes(name)) mark(path, 'prototype-receiver-call');
      }
      const value = resolve(path);
      if (sensitiveValue(value) && !safeUse(path)) mark(path, 'result-escape');
    },
    MemberExpression(path) {
      const value = resolve(path);
      if (sensitiveValue(value) && !safeUse(path)) mark(path, 'prototype-escape');
    },
    ReferencedIdentifier(path) {
      const value = resolve(path);
      if (sensitiveValue(value) && !safeUse(path)) mark(path, 'intrinsic-alias-escape');
    },
  });
  // Resolving a later global key can add a native string-method dependency.
  // Recheck earlier explicit mutations against those extra proof methods too.
  for (const { path, value } of writes) if (isFamily(value) && value.root === 'String' && value.parts[0] === 'prototype' && keyProofMethods.has(value.parts[1])) mark(path, 'key-proof-method-mutation');
  for (const call of calls) if (mutationHazard(call)) mark(call, 'intrinsic-mutator');
  return hazardous;
}

module.exports = { jsonIntrinsicHazard };
