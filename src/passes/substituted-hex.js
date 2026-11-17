'use strict';

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { analyzeDynamicScope } = require('./_dynamic-scope');
const { isWrite, isPublic } = require('./_utils');

const PRIVATE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'name', 'length', 'caller', 'arguments',
  'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable']);
const SCHEMA = `function decode(input) {
  if (null == input || void 0 == input) return input;
  if (0 != input.length % 2) throw Error('1100');
  for (var output = [], cursor = 0; cursor < input.length; cursor++) {
    if (0 == cursor % 2) { output.push('%'); }
    for (var digits = alphabet, index = 0; index < digits.length; index++) if (input.charAt(cursor) == digits[index]) {
      output.push(index.toString(16)); break;
    }
  }
  return decodeURIComponent(output.join(''));
}`;

function inside(path, ancestor) {
  for (let current = path; current; current = current.parentPath) if (current === ancestor) return true;
  return false;
}
function property(node) {
  if (!t.isMemberExpression(node)) return null;
  if (!node.computed && t.isIdentifier(node.property)) return node.property.name;
  return t.isStringLiteral(node.property) ? node.property.value : null;
}
function bindingOf(path) {
  if (path.isFunctionDeclaration()) return path.parentPath.scope.getBinding(path.node.id.name);
  return null;
}
function stable(binding, reference) {
  return !!binding && binding.constant && (binding.path.isFunctionDeclaration() || !reference ||
    binding.path.node.start == null || reference.node.start == null || binding.path.node.start < reference.node.start);
}
function exported(binding) {
  return !!binding && (!!binding.path.findParent(path => path.isExportNamedDeclaration() || path.isExportDefaultDeclaration()) ||
    binding.referencePaths.some(path => path.findParent(parent => parent.isExportSpecifier() || parent.isExportDefaultDeclaration())));
}

function fingerprint(node, alphabetName) {
  if (!t.isFunction(node) || node.async || node.generator || !t.isBlockStatement(node.body)) return null;
  const fn = t.functionDeclaration(t.identifier('$subject'), node.params.map(parameter => t.cloneNode(parameter, true)), t.cloneNode(node.body, true));
  const ast = t.file(t.program([fn]));
  require('./normalize-literals').run(ast);
  for (let iteration = 0; iteration < 3; iteration++) if (!require('./normalize-statements').run(ast)) break;
  let root;
  traverse(ast, { FunctionDeclaration(path) { root = path; path.stop(); } });
  const locals = new Map();
  const visit = path => {
    if (!path || !path.node) return null;
    const node = path.node;
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(node.name);
      if (binding && inside(binding.path, root)) {
        if (!locals.has(binding)) locals.set(binding, '$local' + locals.size);
        return ['Identifier', locals.get(binding)];
      }
      return ['Identifier', !binding && node.name === alphabetName ? '$alphabet' : node.name];
    }
    if (path.isStringLiteral() || path.isNumericLiteral() || path.isBooleanLiteral()) return [node.type, node.value];
    if (path.isNullLiteral()) return ['NullLiteral'];
    if (path.isMemberExpression()) {
      const name = property(node);
      return ['MemberExpression', visit(path.get('object')), name === null ? visit(path.get('property')) : ['property', name]];
    }
    const result = [node.type];
    for (const key of ['operator', 'kind', 'prefix', 'async', 'generator', 'optional']) if (node[key] !== undefined) result.push([key, node[key]]);
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      if (path === root && key === 'id') continue;
      const child = path.get(key);
      result.push([key, Array.isArray(child) ? child.map(visit) : visit(child)]);
    }
    return result;
  };
  return JSON.stringify(visit(root));
}
const EXPECTED = fingerprint(parser.parse(SCHEMA).program.body[0], 'alphabet');

function primitive(node) {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node)) return true;
  return t.isUnaryExpression(node) && ((['+', '-'].includes(node.operator) && t.isNumericLiteral(node.argument)) ||
    node.operator === 'void' && t.isNumericLiteral(node.argument));
}

function run(ast, context = {}) {
  const options = context.options || {};
  const maximumOperations = Math.min(10000000, Math.max(1000, Number(options.maxDecoderOperations) || 2000000));
  const maximumLength = Math.min(1000000, Math.max(1024, Number(options.maxDecodedStringLength) || 100000));
  const warnings = new Set();
  const warn = (code, message, details) => {
    const key = code + JSON.stringify(details || null);
    if (!warnings.has(key) && context.warn) context.warn(code, message, details);
    warnings.add(key);
  };
  let operations = 0, stopped = false, changes = 0;
  const budget = () => {
    if (++operations > maximumOperations) {
      stopped = true;
      warn('STRING_DECODER_OPERATION_LIMIT', 'Substituted-hex decoding stopped at the configured operation limit.', { maximumOperations });
      throw new Error('STATIC_OPERATION_LIMIT');
    }
  };
  const scope = analyzeDynamicScope(ast, { context });
  const families = [];
  const constructors = new Map(), methods = new Map();
  const declarationPaths = new Map();

  traverse(ast, { FunctionDeclaration(path) {
    if (path.node.params.length || path.node.async || path.node.generator) return;
    const binding = bindingOf(path);
    if (!stable(binding) || exported(binding) || scope.affectsBinding(binding)) return;
    const body = path.get('body.body');
    if (body.length < 2 || !body[0].isVariableDeclaration() || body[0].node.declarations.length !== 1) return;
    const declaration = body[0].get('declarations.0'), init = declaration.get('init');
    if (!declaration.get('id').isIdentifier() || !init.isCallExpression() || init.node.arguments.length !== 1 ||
        !init.get('arguments.0').isStringLiteral({ value: '' }) || !init.get('callee').isMemberExpression() ||
        property(init.node.callee) !== 'split' || !init.get('callee.object').isStringLiteral()) return;
    const alphabet = init.node.callee.object.value;
    if (alphabet.length !== 16 || new Set(alphabet).size !== 16) return;
    const alphabetBinding = declaration.scope.getBinding(declaration.node.id.name);
    if (!alphabetBinding || !alphabetBinding.constant) return;
    const methodPaths = new Map();
    let unsupported = false;
    for (const statement of body.slice(1)) {
      const assignments = statement.isExpressionStatement() ? statement.get('expression').isSequenceExpression()
        ? statement.get('expression.expressions') : [statement.get('expression')] : [];
      if (!assignments.length) { unsupported = true; break; }
      for (const assignment of assignments) {
        const left = assignment.isAssignmentExpression({ operator: '=' }) ? assignment.get('left') : null;
        const right = assignment.isAssignmentExpression({ operator: '=' }) ? assignment.get('right') : null;
        const name = left && property(left.node);
        if (!left || !left.isMemberExpression() || !left.get('object').isThisExpression() || !name || PRIVATE_KEYS.has(name) ||
            methodPaths.has(name) || !right.isFunctionExpression() || right.node.id ||
            fingerprint(right.node, declaration.node.id.name) !== EXPECTED) { unsupported = true; break; }
        let shadowed = false;
        right.traverse({ ReferencedIdentifier(reference) {
          if (['decodeURIComponent', 'Error'].includes(reference.node.name) && reference.scope.getBinding(reference.node.name)) shadowed = true;
        } });
        if (shadowed) { unsupported = true; break; }
        methodPaths.set(name, right);
      }
    }
    if (unsupported || !methodPaths.size) {
      warn('UNSUPPORTED_SUBSTITUTED_HEX', 'Substituted-hex constructor contains an unsupported method, side effect or return transformation.', { name: binding.identifier.name });
      return;
    }
    const family = { binding, path, alphabet, methodPaths, aliases: new Set(), instances: new Set(), constructors: new Set(), usable: true, declarations: new Set() };
    constructors.set(binding, family);
    families.push(family);
  } });

  function pureInitializer(path, seen = new Set()) {
    if (!path || !path.node) return true;
    if (primitive(path.node) || path.isArrayExpression() && path.node.elements.every(primitive)) return true;
    if (path.isNewExpression() && !path.node.arguments.length) return !!resolveConstructor(path.get('callee'));
    if (path.isMemberExpression()) {
      const family = resolveInstance(path.get('object'));
      return !!family && family.methodPaths.has(property(path.node));
    }
    if (!path.isIdentifier()) return false;
    const binding = path.scope.getBinding(path.node.name);
    if (!stable(binding, path) || seen.has(binding) || seen.size > 80) return false;
    if (constructors.has(binding)) return true;
    if (!binding.path.isVariableDeclarator()) return false;
    const next = new Set(seen); next.add(binding);
    return pureInitializer(binding.path.get('init'), next);
  }
  function initialized(binding, reference) {
    if (!stable(binding, reference)) return false;
    if (binding.path.isFunctionDeclaration()) return true;
    const declaration = binding.path;
    if (!declaration.isVariableDeclarator() || reference.node.start != null && declaration.node.end != null && reference.node.start < declaration.node.end) return false;
    const statement = declaration.parentPath;
    const container = statement.parentPath;
    if (!statement.isVariableDeclaration() || !(container.isProgram() || container.isBlockStatement() && container.parentPath.isFunction() && container.key === 'body')) return false;
    let child = reference;
    while (child && child.parentPath !== container) child = child.parentPath;
    if (!child || !child.inList || child.key < statement.key) return false;
    if (declaration.getFunctionParent() === reference.getFunctionParent()) return true;
    const owner = declaration.getFunctionParent();
    if (owner && !owner.node.params.every(parameter => t.isIdentifier(parameter))) return false;
    for (const previous of container.get('body').slice(0, statement.key)) {
      if (previous.isFunctionDeclaration() || previous.isEmptyStatement()) continue;
      if (!previous.isVariableDeclaration() || !previous.get('declarations').every(item => pureInitializer(item.get('init')))) return false;
    }
    const previousDeclarations = statement.get('declarations').slice(0, declaration.key);
    return previousDeclarations.every(item => pureInitializer(item.get('init')));
  }

  function privateMethod(binding, family, seen = new Set()) {
    if (!stable(binding) || seen.has(binding) || seen.size > 80 || scope.affectsBinding(binding)) return false;
    seen.add(binding); family.aliases.add(binding);
    if (binding.path.isVariableDeclarator()) { family.declarations.add(binding.path.node); declarationPaths.set(binding.path.node, binding.path); }
    methods.set(binding, family);
    for (const reference of binding.referencePaths) {
      if (inside(reference, family.path)) continue;
      if (!initialized(binding, reference)) return false;
      if (reference.parentPath.isCallExpression() && reference.key === 'callee' && reference.parentPath.node.arguments.length === 1) continue;
      if (reference.parentPath.isVariableDeclarator() && reference.key === 'init' && reference.parentPath.get('id').isIdentifier() &&
          privateMethod(reference.scope.getBinding(reference.parentPath.node.id.name), family, new Set(seen))) continue;
      return false;
    }
    return true;
  }
  function methodUse(member, family) {
    if (!member.isMemberExpression() || !family.methodPaths.has(property(member.node))) return false;
    const parent = member.parentPath;
    if (parent.isCallExpression() && member.key === 'callee' && parent.node.arguments.length === 1) return true;
    return parent.isVariableDeclarator() && member.key === 'init' && parent.get('id').isIdentifier() &&
      privateMethod(parent.scope.getBinding(parent.node.id.name), family);
  }
  function privateInstance(binding, family, seen = new Set()) {
    if (!stable(binding) || seen.has(binding) || seen.size > 80 || scope.affectsBinding(binding)) return false;
    seen.add(binding); family.instances.add(binding); family.declarations.add(binding.path.node);
    declarationPaths.set(binding.path.node, binding.path);
    for (const reference of binding.referencePaths) {
      if (!initialized(binding, reference)) return false;
      if (reference.parentPath.isMemberExpression() && reference.key === 'object' && methodUse(reference.parentPath, family)) continue;
      if (reference.parentPath.isVariableDeclarator() && reference.key === 'init' && reference.parentPath.get('id').isIdentifier() &&
          privateInstance(reference.scope.getBinding(reference.parentPath.node.id.name), family, new Set(seen))) continue;
      return false;
    }
    return true;
  }
  function privateConstructor(binding, family, seen = new Set()) {
    if (!stable(binding) || seen.has(binding) || seen.size > 80 || scope.affectsBinding(binding)) return false;
    seen.add(binding); family.constructors.add(binding);
    if (binding.path.isVariableDeclarator()) { family.declarations.add(binding.path.node); declarationPaths.set(binding.path.node, binding.path); }
    for (const reference of binding.referencePaths) {
      if (inside(reference, family.path)) continue;
      if (!initialized(binding, reference)) return false;
      const parent = reference.parentPath;
      if (parent.isVariableDeclarator() && reference.key === 'init' && parent.get('id').isIdentifier() &&
          privateConstructor(parent.scope.getBinding(parent.node.id.name), family, new Set(seen))) continue;
      if (!parent.isNewExpression() || reference.key !== 'callee' || parent.node.arguments.length) return false;
      if (parent.parentPath.isMemberExpression() && parent.key === 'object' && methodUse(parent.parentPath, family)) continue;
      if (parent.parentPath.isVariableDeclarator() && parent.key === 'init' && parent.parentPath.get('id').isIdentifier() &&
          privateInstance(parent.scope.getBinding(parent.parentPath.node.id.name), family)) continue;
      return false;
    }
    return true;
  }
  for (const family of families) if (!privateConstructor(family.binding, family)) {
    family.usable = false;
    warn('UNSUPPORTED_SUBSTITUTED_HEX_ESCAPE', 'Substituted-hex constructor, instance or method escapes its recognized private uses.', { name: family.binding.identifier.name });
  }

  // Ambient intrinsics are assumed intact; explicit writes or escapes in this
  // input to the exact methods used by the schema defeat that assumption.
  const protectedNames = {
    String: new Set(['split', 'charAt']), Array: new Set(['push', 'join']), Number: new Set(['toString']),
    Object: new Set(families.flatMap(family => [...family.methodPaths.keys()])),
  };
  function intrinsicChain(path, seen = new Set()) {
    if (!path || !path.node || seen.size > 80) return null;
    if (path.isMemberExpression()) {
      const object = intrinsicChain(path.get('object'), seen);
      return object && object.concat(property(path.node));
    }
    if (!path.isIdentifier()) return null;
    const binding = path.scope.getBinding(path.node.name);
    if (!binding) return ['String', 'Array', 'Number', 'Object', 'Reflect', 'decodeURIComponent', 'globalThis', 'window'].includes(path.node.name) ? [path.node.name] : null;
    if (!stable(binding, path) || seen.has(binding) || !binding.path.isVariableDeclarator()) return null;
    const next = new Set(seen); next.add(binding);
    return intrinsicChain(binding.path.get('init'), next);
  }
  const normalizeChain = chain => chain && ['window', 'globalThis'].includes(chain[0]) ? chain.slice(1) : chain;
  function sensitive(chain) {
    chain = normalizeChain(chain);
    if (!chain || !chain.length) return false;
    if (chain[0] === 'decodeURIComponent') return true;
    if (!protectedNames[chain[0]]) return false;
    if (chain.length === 1) return true;
    if (chain[1] === null) return true;
    return chain[1] === 'prototype' && (chain.length < 3 || chain[2] === null || protectedNames[chain[0]].has(chain[2]));
  }
  let polluted = false;
  traverse(ast, {
    AssignmentExpression(path) { if (sensitive(intrinsicChain(path.get('left')))) polluted = true; },
    UpdateExpression(path) { if (sensitive(intrinsicChain(path.get('argument')))) polluted = true; },
    UnaryExpression(path) { if (path.node.operator === 'delete' && sensitive(intrinsicChain(path.get('argument')))) polluted = true; },
    CallExpression(path) {
      const callee = normalizeChain(intrinsicChain(path.get('callee')));
      const mutator = callee && ['Object', 'Reflect'].includes(callee[0]) && ['defineProperty', 'defineProperties', 'assign', 'setPrototypeOf', 'set'].includes(callee[1]);
      if (mutator && path.node.arguments.length) {
        if (callee.length > 2) { polluted = true; return; }
        const target = intrinsicChain(path.get('arguments.0'));
        if (!target) return;
        const key = path.get('arguments.1');
        if (sensitive(target.concat(['defineProperty', 'set'].includes(callee[1]) && key && key.isStringLiteral() ? key.node.value : null))) polluted = true;
        return;
      }
      for (const argument of path.get('arguments')) {
        const chain = normalizeChain(intrinsicChain(argument));
        if (chain && (chain.length === 1 || chain.length === 2 && chain[1] === 'prototype') && sensitive(chain)) polluted = true;
      }
    },
  });
  if (polluted) for (const family of families) {
    family.usable = false;
    warn('UNSUPPORTED_SUBSTITUTED_HEX_INTRINSIC', 'Substituted-hex calls were preserved because required intrinsic methods are explicitly modified or escaped.', { name: family.binding.identifier.name });
  }

  function resolveConstructor(path, seen = new Set()) {
    if (!path.isIdentifier()) return null;
    const binding = path.scope.getBinding(path.node.name);
    if (!stable(binding, path) || seen.has(binding) || seen.size > 80) return null;
    if (constructors.has(binding)) return constructors.get(binding);
    if (!binding.path.isVariableDeclarator()) return null;
    const next = new Set(seen); next.add(binding);
    return resolveConstructor(binding.path.get('init'), next);
  }
  function resolveInstance(path, seen = new Set()) {
    if (path.isNewExpression() && !path.node.arguments.length) return resolveConstructor(path.get('callee'));
    if (!path.isIdentifier()) return null;
    const binding = path.scope.getBinding(path.node.name);
    if (!stable(binding, path) || seen.has(binding) || seen.size > 80 || !binding.path.isVariableDeclarator()) return null;
    const next = new Set(seen); next.add(binding);
    return resolveInstance(binding.path.get('init'), next);
  }
  function resolveMethod(path) {
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      return initialized(binding, path) && methods.get(binding) || null;
    }
    if (!path.isMemberExpression()) return null;
    const family = resolveInstance(path.get('object'));
    return family && family.methodPaths.has(property(path.node)) ? family : null;
  }
  function decode(value, family) {
    if (value.length > maximumLength) {
      warn('STRING_DECODER_LENGTH_LIMIT', 'Substituted-hex input exceeds the configured string length limit.', { name: family.binding.identifier.name, maximumLength });
      return null;
    }
    if (value.length % 2) return null;
    let encoded = '';
    for (let index = 0; index < value.length; index++) {
      budget();
      const digit = family.alphabet.indexOf(value.charAt(index));
      if (digit < 0) return null;
      if (index % 2 === 0) encoded += '%';
      encoded += digit.toString(16);
    }
    const decoded = decodeURIComponent(encoded);
    if (decoded.length > maximumLength) {
      warn('STRING_DECODER_LENGTH_LIMIT', 'Substituted-hex result exceeds the configured string length limit.', { name: family.binding.identifier.name, maximumLength });
      return null;
    }
    return decoded;
  }

  traverse(ast, { CallExpression: { exit(path) {
    if (stopped || path.node.arguments.length !== 1 || !path.get('arguments.0').isStringLiteral() || scope.affectsPath(path)) return;
    const family = resolveMethod(path.get('callee'));
    if (!family || !family.usable || inside(path, family.path)) return;
    try {
      const value = decode(path.node.arguments[0].value, family);
      if (value !== null) {
        if (typeof context.onStaticValue === 'function') context.onStaticValue(path.node, value);
        path.replaceWith(t.stringLiteral(value)); changes++;
      }
    } catch (error) {
      if (error.message !== 'STATIC_OPERATION_LIMIT') warn('UNSUPPORTED_SUBSTITUTED_HEX_VALUE', 'Substituted-hex call was preserved because its literal is not valid encoded UTF-8.', { name: family.binding.identifier.name });
    }
  } } });

  // Own primitive array entries can be read without coercion or getters when
  // every reference stays private and no writes/method calls/escapes occur.
  const arrayDeclarations = new Set();
  for (let iteration = 0; iteration < 4 && !stopped; iteration++) {
    let replaced = 0;
    traverse(ast, { VariableDeclarator(path) {
      if (stopped || !path.get('id').isIdentifier() || !path.get('init').isArrayExpression() || !path.node.init.elements.every(primitive)) return;
      const root = path.scope.getBinding(path.node.id.name);
      if (!stable(root) || exported(root) || scope.affectsBinding(root)) return;
      const references = [], aliases = new Set();
      const privateArray = binding => {
        if (!stable(binding) || exported(binding) || aliases.has(binding) || aliases.size > 80 || scope.affectsBinding(binding)) return false;
        aliases.add(binding);
        for (const reference of binding.referencePaths) {
          const parent = reference.parentPath;
          if (parent.isVariableDeclarator() && reference.key === 'init' && parent.get('id').isIdentifier() && privateArray(parent.scope.getBinding(parent.node.id.name))) continue;
          if (!parent.isMemberExpression() || reference.key !== 'object' || parent.parentPath.isCallExpression() && parent.key === 'callee' || isWrite(parent)) return false;
          if (!parent.node.computed && property(parent.node) !== 'length' || parent.node.computed && !parent.get('property').isNumericLiteral() && !parent.get('property').isIdentifier()) return false;
          references.push({ member: parent, binding });
        }
        return true;
      };
      if (!privateArray(root)) return;
      for (const binding of aliases) arrayDeclarations.add(binding.path);
      for (const { member, binding } of references) {
        if (stopped || !member.node || scope.affectsPath(member) || !initialized(root, member) || !initialized(binding, member)) continue;
        let value;
        if (!member.node.computed && property(member.node) === 'length') value = t.numericLiteral(path.node.init.elements.length);
        else if (member.get('property').isNumericLiteral()) {
          const index = member.node.property.value;
          if (Number.isInteger(index) && index >= 0 && index < path.node.init.elements.length) value = t.cloneNode(path.node.init.elements[index], true);
        }
        if (!value) continue;
        try { budget(); } catch (error) { break; }
        if (typeof context.onStaticValue === 'function') context.onStaticValue(member.node, value);
        member.replaceWith(value); changes++; replaced++;
      }
    } });
    if (!replaced) break;
  }
  let program;
  traverse(ast, { Program(path) { program = path; path.stop(); } });
  const removed = { aliases: 0, constructors: 0, arrays: 0 };
  function refresh() { if (program) program.scope.crawl(); }
  function removeDeclaration(path, kind, allowPublic) {
    if (!path || !path.node || path.removed) return false;
    const name = path.isFunctionDeclaration() ? path.node.id.name : path.node.id && path.node.id.name;
    const binding = name && path.scope.getBinding(name);
    if (!binding || !binding.constant || binding.referencePaths.length || scope.affectsBinding(binding) ||
        !allowPublic && isPublic(binding) || path.findParent(parent => parent.isExportNamedDeclaration() || parent.isExportDefaultDeclaration())) return false;
    if (path.isVariableDeclarator() && path.parentPath.node.declarations.length === 1) path.parentPath.remove(); else path.remove();
    removed[kind]++; changes++;
    return true;
  }
  refresh();
  const readable = options.profile === 'readable';
  const cleanupLimit = Math.min(1000, arrayDeclarations.size + families.reduce((count, family) => count + family.declarations.size + 1, 0) + 1);
  for (let iteration = 0; iteration < cleanupLimit; iteration++) {
    let count = 0;
    for (const path of [...arrayDeclarations].reverse()) if (removeDeclaration(path, 'arrays', readable)) count++;
    if (readable) for (const family of families) if (family.usable) {
      for (const node of [...family.declarations].reverse()) if (removeDeclaration(declarationPaths.get(node), 'aliases', true)) count++;
      if (removeDeclaration(family.path, 'constructors', true)) count++;
    }
    if (!count) break;
    refresh();
  }
  if (readable && removed.aliases + removed.constructors + removed.arrays) warn('READABLE_HEX_SCAFFOLD_REMOVED', 'Removed unused, unexported pure decoder scaffolding and primitive arrays in the readable profile.', {
    ...removed, assumption: 'Unreferenced unexported bindings have no external host consumers.',
  });
  if (context.state) context.state.set('substituted-hex:families', { ast, families: families.map(family => ({
    constructorNode: family.path.node, aliasNodes: [...family.declarations], usable: family.usable,
  })) });
  return changes;
}

// This layered proof API transforms an isolated copy only. The map retains the
// original source node identities so callers can resolve keys before changing
// the actual AST or deciding whether dynamic scope permits such a change.
function createStaticResolver(ast, context = {}, resolveOuter = () => undefined) {
  const clone = t.cloneNode(ast, true);
  const originals = new WeakMap(), values = new WeakMap();
  function connect(source, copy) {
    if (!source || !copy) return;
    originals.set(copy, source);
    if (source.start != null) copy.start = source.start;
    if (source.end != null) copy.end = source.end;
    for (const key of t.VISITOR_KEYS[source.type] || []) {
      if (Array.isArray(source[key])) source[key].forEach((node, index) => connect(node, copy[key][index]));
      else connect(source[key], copy[key]);
    }
  }
  connect(ast, clone);
  const outerValues = new WeakMap();
  traverse(ast, { CallExpression(path) {
    const value = resolveOuter(path);
    if (typeof value === 'string') outerValues.set(path.node, value);
  } });
  traverse(clone, { CallExpression: { exit(path) {
    const original = originals.get(path.node);
    if (!original || !outerValues.has(original)) return;
    const value = outerValues.get(original);
    values.set(original, value);
    const replacement = t.stringLiteral(value);
    replacement.start = path.node.start; replacement.end = path.node.end;
    path.replaceWith(replacement);
  } } });
  run(clone, {
    options: { ...(context.options || {}), profile: 'safe' },
    warn: context.warn,
    onStaticValue(node, value) {
      const original = originals.get(node);
      if (!original) return;
      if (typeof value === 'string') values.set(original, value);
      else if (value && (t.isStringLiteral(value) || t.isNumericLiteral(value) || t.isBooleanLiteral(value))) values.set(original, value.value);
      else if (t.isNullLiteral(value)) values.set(original, null);
      else if (t.isUnaryExpression(value) && t.isNumericLiteral(value.argument)) values.set(original, value.operator === '-' ? -value.argument.value : value.operator === '+' ? +value.argument.value : undefined);
    },
  });
  return path => {
    const node = path && path.node || path;
    if (!node) return undefined;
    if (values.has(node)) return values.get(node);
    if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return node.value;
    if (t.isNullLiteral(node)) return null;
    return undefined;
  };
}

module.exports = { name: 'decode-substituted-hex', description: 'Decode private canonical substituted-hex helpers and immutable primitive array lookups without executing source.', run, createStaticResolver };
