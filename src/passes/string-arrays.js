'use strict';

const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const parser = require('@babel/parser');
const { decodeBase64, decodeRc4 } = require('../decoders/strings');
const { analyzeDynamicScope } = require('./_dynamic-scope');
const { isRestrictedJsonEval } = require('../analysis/restricted-json-eval');

const UNKNOWN = Symbol('unknown');
const DEFAULT_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';
const FUNCTION_PROPERTIES = new Set(['name', 'length', 'prototype', 'arguments', 'caller', 'call', 'apply', 'bind',
  'constructor', '__proto__', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

function isAlphabet(value) {
  return typeof value === 'string' && (value.length === 64 || value.length === 65) &&
    new Set(value.slice(0, 64)).size === 64 &&
    !value.slice(0, 64).includes('=') &&
    (value.length === 64 || value[64] === '=');
}

// A trusted implementation schema, never obtained by executing the input. The
// comparison below permits renamed bindings/cache properties, a different
// alphabet and an index offset, but no additional calls, writes or transforms.
const CACHED_DIRECT_SCHEMA = `function decoder(index, unused) {
  index = index - 0;
  var value = table[index];
  if (decoder.ready === undefined) {
    var base64 = function(input) {
      var alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';
      var output = '';
      for (var count = 0, bits, digit, cursor = 0;
        digit = input.charAt(cursor++);
        ~digit && (bits = count % 4 ? bits * 64 + digit : digit, count++ % 4)
          ? output += String.fromCharCode(255 & bits >> (-2 * count & 6)) : 0) {
        digit = alphabet.indexOf(digit);
      }
      return output;
    };
    decoder.transform = function(input) {
      var bytes = base64(input);
      var encoded = [];
      for (var cursor = 0, length = bytes.length; cursor < length; cursor++) {
        encoded += '%' + ('00' + bytes.charCodeAt(cursor).toString(16)).slice(-2);
      }
      return decodeURIComponent(encoded);
    }, decoder.cache = {}, decoder.ready = !![];
  }
  var first = table[0], key = index + first, cached = decoder.cache[key];
  return cached === undefined
    ? (value = decoder.transform(value), decoder.cache[key] = value)
    : value = cached, value;
}`;

function directSchemaFingerprint(node, tableName) {
  if (!t.isFunctionDeclaration(node)) return null;
  const clone = t.cloneNode(node, true);
  if (!clone.id) return null;
  const ast = t.file(t.program([clone]));
  // Normalization happens only on an isolated copy, so this also recognizes
  // the same schema after the normal pipeline has exposed its sequences.
  require('./normalize-literals').run(ast);
  for (let index = 0; index < 3; index++) if (!require('./normalize-statements').run(ast)) break;
  let root;
  traverse(ast, { FunctionDeclaration(path) { if (!root) { root = path; path.stop(); } } });
  if (!root) return null;
  const self = functionBinding(root), locals = new Map(), properties = new Map();
  const localName = binding => {
    if (binding === self) return '$decoder';
    if (!locals.has(binding)) locals.set(binding, '$local' + locals.size);
    return locals.get(binding);
  };
  let offsetNode = null;
  const first = root.get('body.body.0');
  if (first && first.isExpressionStatement()) {
    const expression = first.get('expression');
    if (expression.isAssignmentExpression({ operator: '=' }) && expression.get('left').isIdentifier() &&
        expression.get('right').isBinaryExpression({ operator: '-' }) && numeric(expression.node.right.right) !== null) {
      offsetNode = expression.node.right.right;
    }
  }
  const visit = path => {
    if (!path || !path.node) return null;
    const n = path.node;
    if (n === offsetNode) return ['$offset'];
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(n.name);
      if (binding && (binding === self || within(binding.path, root))) return ['Identifier', localName(binding)];
      if (!binding && n.name === tableName) return ['Identifier', '$table'];
      return ['Identifier', n.name];
    }
    if (path.isStringLiteral()) return ['StringLiteral', isAlphabet(n.value) ? '$alphabet' : n.value];
    if (path.isNumericLiteral() || path.isBooleanLiteral()) return [n.type, n.value];
    if (path.isNullLiteral()) return ['NullLiteral'];
    if (path.isUnaryExpression({ operator: '!' }) && t.isUnaryExpression(n.argument, { operator: '!' }) && t.isArrayExpression(n.argument.argument) && !n.argument.argument.elements.length) return ['BooleanLiteral', true];
    if (path.isMemberExpression()) {
      let property = memberName(n);
      const object = path.get('object');
      if (object.isIdentifier() && object.scope.getBinding(object.node.name) === self && property !== null) {
        if (!properties.has(property)) properties.set(property, '$property' + properties.size);
        property = properties.get(property);
      }
      return ['MemberExpression', visit(object), property === null ? visit(path.get('property')) : ['property', property]];
    }
    const result = [n.type];
    for (const key of ['operator', 'kind', 'prefix', 'async', 'generator', 'optional']) if (n[key] !== undefined) result.push([key, n[key]]);
    for (const key of t.VISITOR_KEYS[n.type] || []) {
      let children = path.get(key);
      if (path === root && key === 'params') children = children.filter(parameter => {
        const binding = parameter.isIdentifier() && parameter.scope.getBinding(parameter.node.name);
        return binding && binding.referencePaths.length;
      });
      result.push([key, Array.isArray(children) ? children.map(visit) : visit(children)]);
    }
    return result;
  };
  return JSON.stringify(visit(root));
}

const CACHED_DIRECT_FINGERPRINT = directSchemaFingerprint(parser.parse(CACHED_DIRECT_SCHEMA).program.body[0], 'table');

function functionBinding(path) {
  if (path.isFunctionDeclaration() && path.node.id) return path.parentPath.scope.getBinding(path.node.id.name);
  if (path.parentPath.isVariableDeclarator() && t.isIdentifier(path.parentPath.node.id)) {
    return path.parentPath.scope.getBinding(path.parentPath.node.id.name);
  }
  return null;
}

function memberName(node) {
  if (!t.isMemberExpression(node)) return null;
  if (!node.computed && t.isIdentifier(node.property)) return node.property.name;
  if (t.isStringLiteral(node.property)) return node.property.value;
  return null;
}

function numeric(node) {
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isUnaryExpression(node) && node.operator === '-' && t.isNumericLiteral(node.argument)) return -node.argument.value;
  return null;
}

function within(path, ancestor) {
  for (let current = path; current; current = current.parentPath) if (current === ancestor) return true;
  return false;
}

function safeBinding(binding, path) {
  if (!binding || (!binding.constant && !binding.constantViolations.every(write => write.node === binding.path.node))) return false;
  if (binding.kind === 'param' || binding.path.isFunctionDeclaration()) return true;
  // Do not move lexical reads across a temporal dead zone, or turn early var reads
  // into initialized values. A lexical source position is a conservative bound.
  return !path || binding.path.node.start == null || path.node.start == null || binding.path.node.start < path.node.start;
}

function run(ast, context = {}) {
  if (context.state) context.state.set('string-arrays:families', { ast, families: [] });
  const options = context.options || {};
  const warn = (code, message, details) => { if (context.warn) context.warn(code, message, details); };
  const maximumOperations = Math.min(10000000, Math.max(1000, Number(options.maxDecoderOperations) || 2000000));
  const maximumRotations = Math.min(100000, Math.max(1, Number(options.maxStringArrayRotations) || 10000));
  const maximumStringLength = Math.min(1000000, Math.max(1024, Number(options.maxDecodedStringLength) || 100000));
  let operations = 0, stopped = false, activeCallPosition = null, decodedDuringEvaluation = false;
  function budget() { if (++operations > maximumOperations) throw new Error('STATIC_OPERATION_LIMIT'); }
  const providers = new Map(), decoders = new Map(), protectedFunctions = new Set();
  let dynamicScope = null;

  traverse(ast, { VariableDeclarator(path) {
    if (!path.get('id').isIdentifier() || !path.get('init').isArrayExpression()) return;
    const elements = path.node.init.elements;
    if (!elements.length || !elements.every(element => t.isStringLiteral(element))) return;
    const binding = path.scope.getBinding(path.node.id.name);
    if (!binding || !binding.constant) return;
    providers.set(binding, { path, binding, values: elements.map(element => element.value),
      functionPath: path, directArray: true, rotation: 0, usable: true, memoized: true });
  } });

  // A provider must actually return the local array (possibly by self-redefining).
  traverse(ast, {
    Function(path) {
      if (path.node.params.length !== 0 || path.node.async || path.node.generator) return;
      const binding = functionBinding(path);
      if (!binding) return;
      const arrays = [];
      path.traverse({
        Function(inner) { if (inner !== path) inner.skip(); },
        VariableDeclarator(candidate) {
          if (!t.isIdentifier(candidate.node.id) || !t.isArrayExpression(candidate.node.init)) return;
          const elements = candidate.node.init.elements;
          if (elements.length === 0 || !elements.every(element => t.isStringLiteral(element))) return;
          arrays.push({ path: candidate, binding: candidate.scope.getBinding(candidate.node.id.name), values: elements.map(element => element.value) });
        },
        ReturnStatement(candidate) {
          if (!t.isArrayExpression(candidate.node.argument) || !candidate.node.argument.elements.length) return;
          if (candidate.node.argument.elements.every(element => t.isStringLiteral(element))) {
            arrays.push({ path: candidate, binding: null, values: candidate.node.argument.elements.map(element => element.value), direct: true });
          }
        }
      });
      if (arrays.length !== 1) return;
      const array = arrays[0];
      let returned = !!array.direct;
      if (!returned) path.traverse({ ReturnStatement(candidate) {
        if (t.isIdentifier(candidate.node.argument) && candidate.scope.getBinding(candidate.node.argument.name) === array.binding) returned = true;
      } });
      if (!returned) return;
      const validSelfAssignment = assignment => {
        if (!assignment.isAssignmentExpression({ operator: '=' }) || !assignment.get('left').isIdentifier() || assignment.scope.getBinding(assignment.node.left.name) !== binding) return false;
        const replacement = assignment.get('right');
        if (!replacement.isFunction() || replacement.node.params.length || !replacement.get('body').isBlockStatement()) return false;
        const statements = replacement.get('body.body');
        return statements.length === 1 && statements[0].isReturnStatement() && statements[0].get('argument').isIdentifier() && statements[0].scope.getBinding(statements[0].node.argument.name) === array.binding;
      };
      const validProviderReturn = expression => {
        if (!expression || !expression.node) return false;
        if (expression.isIdentifier()) return expression.scope.getBinding(expression.node.name) === array.binding;
        if (expression.isArrayExpression()) return array.direct && expression === array.path.get('argument');
        if (expression.isCallExpression()) return expression.node.arguments.length === 0 && expression.get('callee').isIdentifier() && expression.scope.getBinding(expression.node.callee.name) === binding;
        if (expression.isSequenceExpression()) {
          const expressions = expression.get('expressions');
          return expressions.slice(0, -1).every(validSelfAssignment) && validProviderReturn(expressions[expressions.length - 1]);
        }
        return false;
      };
      if (!path.get('body').isBlockStatement() || !path.get('body.body').every(statement => {
        if (statement.isVariableDeclaration()) return statement.get('declarations').every(declaration => declaration === array.path);
        if (statement.isExpressionStatement()) return validSelfAssignment(statement.get('expression'));
        if (statement.isReturnStatement()) return validProviderReturn(statement.get('argument'));
        return false;
      })) {
        warn('UNSUPPORTED_STRING_PROVIDER', 'Candidate string provider has additional statements or conditional returns.', { name: binding.identifier.name });
        return;
      }
      let unsafeProvider = false;
      path.traverse({
        CallExpression(call) {
          if (!call.get('callee').isIdentifier() || call.scope.getBinding(call.node.callee.name) !== binding) unsafeProvider = true;
        },
        AssignmentExpression(assignment) {
          if (!t.isIdentifier(assignment.node.left) || assignment.scope.getBinding(assignment.node.left.name) !== binding || !t.isFunction(assignment.node.right)) unsafeProvider = true;
        },
        UpdateExpression() { unsafeProvider = true; },
        ThrowStatement() { unsafeProvider = true; },
        NewExpression() { unsafeProvider = true; }
      });
      if (unsafeProvider) return;
      const externalWrites = binding.constantViolations.filter(write => !within(write, path));
      if (externalWrites.length) return;
      providers.set(binding, { ...array, binding, functionPath: path, rotation: 0, usable: true, memoized: binding.constantViolations.some(write => within(write, path)) });
      protectedFunctions.add(path);
    }
  });

  // Match an actual table lookup and derive its index transformation.
  traverse(ast, {
    Function(path) {
      if (path.node.async || path.node.generator) return;
      const binding = functionBinding(path);
      if (!binding || providers.has(binding)) return;
      const tables = new Map();
      for (const [tableBinding, provider] of providers) if (provider.directArray &&
          path.scope.getBinding(tableBinding.identifier.name) === tableBinding) tables.set(tableBinding, provider);
      path.traverse({ VariableDeclarator(candidate) {
        const init = candidate.get('init');
        if (!t.isIdentifier(candidate.node.id) || !init.isCallExpression() || !init.get('callee').isIdentifier()) return;
        const provider = providers.get(init.scope.getBinding(init.node.callee.name));
        if (provider && !init.node.arguments.length) tables.set(candidate.scope.getBinding(candidate.node.id.name), provider);
      } });
      if (!tables.size) return;
      let tableMutation = false;
      path.traverse({
        AssignmentExpression(assignment) {
          const left = assignment.get('left');
          if (left.isMemberExpression() && t.isIdentifier(left.node.object) && tables.has(left.scope.getBinding(left.node.object.name))) tableMutation = true;
        },
        UpdateExpression(update) {
          const argument = update.get('argument');
          if (argument.isMemberExpression() && t.isIdentifier(argument.node.object) && tables.has(argument.scope.getBinding(argument.node.object.name))) tableMutation = true;
        },
        CallExpression(call) {
          const callee = call.get('callee');
          if (callee.isMemberExpression() && t.isIdentifier(callee.node.object) && tables.has(callee.scope.getBinding(callee.node.object.name))) tableMutation = true;
        }
      });
      if (tableMutation) {
        warn('UNSUPPORTED_STRING_DECODER', 'String decoder mutates its shared table.', { name: binding.identifier.name });
        return;
      }
      let found = null;
      path.traverse({ MemberExpression(member) {
        if (found || !member.node.computed || !t.isIdentifier(member.node.object)) return;
        const provider = tables.get(member.scope.getBinding(member.node.object.name));
        if (!provider) return;
        let indexPath = member.get('property'), adjustment = 0, propertyTransform = null;
        if (indexPath.isBinaryExpression() && ['+', '-'].includes(indexPath.node.operator)) {
          const literal = numeric(indexPath.node.right);
          if (literal === null) return;
          adjustment += indexPath.node.operator === '+' ? literal : -literal;
          propertyTransform = { operator: indexPath.node.operator, value: literal };
          indexPath = indexPath.get('left');
        }
        if (!indexPath.isIdentifier()) return;
        const indexBinding = indexPath.scope.getBinding(indexPath.node.name);
        if (!indexBinding || indexBinding.kind !== 'param') return;
        const owner = indexBinding.scope.path;
        const argumentIndex = owner.node.params.findIndex(parameter => t.isIdentifier(parameter, { name: indexPath.node.name }));
        if (argumentIndex < 0) return;
        let supported = true;
        const transformations = [];
        for (const violation of [...indexBinding.constantViolations].sort((left, right) => left.node.start - right.node.start)) {
          if (!violation.isAssignmentExpression() || violation.node.operator !== '=' || violation.node.start > member.node.start) { supported = false; break; }
          const expression = violation.node.right;
          if (!t.isBinaryExpression(expression) || !['-', '+'].includes(expression.operator) || !t.isIdentifier(expression.left, { name: indexPath.node.name }) || numeric(expression.right) === null) { supported = false; break; }
          adjustment += expression.operator === '+' ? numeric(expression.right) : -numeric(expression.right);
          transformations.push({ operator: expression.operator, value: numeric(expression.right) });
        }
        if (propertyTransform) transformations.push(propertyTransform);
        if (supported) found = { provider, argumentIndex, adjustment, transformations, lookup: member, owner };
      } });
      if (!found || binding.constantViolations.some(write => !within(write, path))) return;
      let resultBinding = null;
      if (found.lookup.parentPath.isVariableDeclarator() && found.lookup.parentPath.get('init') === found.lookup && t.isIdentifier(found.lookup.parentPath.node.id)) {
        resultBinding = found.lookup.parentPath.scope.getBinding(found.lookup.parentPath.node.id.name);
      }
      if (found.provider.directArray && directSchemaFingerprint(path.node, found.provider.binding.identifier.name) === CACHED_DIRECT_FINGERPRINT) {
        let alphabet = null, shadowed = false, unsafeProperty = false;
        const propertyNames = new Set();
        path.traverse({
          StringLiteral(literal) { if (isAlphabet(literal.node.value)) alphabet = literal.node.value; },
          MemberExpression(member) {
            if (t.isIdentifier(member.node.object) && member.scope.getBinding(member.node.object.name) === binding) {
              const name = memberName(member.node);
              if (name !== null) {
                propertyNames.add(name);
                if (FUNCTION_PROPERTIES.has(name)) unsafeProperty = true;
              }
            }
          },
          ReferencedIdentifier(identifier) {
            if (['undefined', 'String', 'decodeURIComponent'].includes(identifier.node.name) && identifier.scope.getBinding(identifier.node.name)) shadowed = true;
          },
        });
        // Obvious writes to the used intrinsics or inherited cache keys defeat
        // the schema even when the lexical names themselves are not shadowed.
        traverse(ast, {
          AssignmentExpression(write) { inspectIntrinsicWrite(write.get('left')); },
          UpdateExpression(write) { inspectIntrinsicWrite(write.get('argument')); },
          UnaryExpression(write) { if (write.node.operator === 'delete') inspectIntrinsicWrite(write.get('argument')); },
          CallExpression(call) {
            if (within(call, path)) return;
            const callee = intrinsicChain(call.get('callee'));
            if (!callee || !['Object', 'Reflect'].includes(callee[0]) || !['defineProperty', 'defineProperties', 'assign', 'set', 'setPrototypeOf'].includes(callee[1])) return;
            if (callee.length > 2) { shadowed = true; return; }
            const target = call.get('arguments.0');
            if (!target || !target.node) return;
            let chain = intrinsicChain(target);
            if (!chain) return;
            const key = call.get('arguments.1');
            if (['defineProperty', 'set'].includes(callee[1])) chain = chain.concat(key && key.isStringLiteral() ? key.node.value : null);
            else chain = chain.concat(null);
            inspectChain(chain);
          },
        });
        function intrinsicChain(target, seen = new Set()) {
          if (seen.size > 80) { shadowed = true; return null; }
          if (target.isMemberExpression()) {
            const object = intrinsicChain(target.get('object'), seen);
            return object && object.concat(staticProperty(target));
          }
          if (!target.isIdentifier()) return null;
          const targetBinding = target.scope.getBinding(target.node.name);
          if (!targetBinding) return ['String', 'Object', 'Function', 'Reflect', 'decodeURIComponent', 'globalThis', 'window'].includes(target.node.name) ? [target.node.name] : null;
          if (seen.has(targetBinding) || !safeBinding(targetBinding, target) || !targetBinding.path.isVariableDeclarator()) return null;
          const next = new Set(seen); next.add(targetBinding);
          return intrinsicChain(targetBinding.path.get('init'), next);
        }
        function staticProperty(member) {
          const name = memberName(member.node);
          if (name !== null) return name;
          const property = member.get('property');
          if (!property.isCallExpression() || !property.get('callee').isIdentifier() ||
              property.scope.getBinding(property.node.callee.name) !== binding || property.node.arguments.length < 1) return null;
          let index = numeric(property.node.arguments[found.argumentIndex]);
          if (index === null) return null;
          for (const transform of found.transformations) index = transform.operator === '+' ? index + transform.value : index - transform.value;
          const encoded = found.provider.values[index];
          if (typeof encoded !== 'string' || encoded.length > maximumStringLength) return null;
          try { return decodeBase64(encoded, alphabet, budget, 'byte-loop'); } catch (error) {
            if (error.message === 'STATIC_OPERATION_LIMIT' && !stopped) {
              stopped = true;
              warn('STRING_DECODER_OPERATION_LIMIT', 'String decoder analysis stopped at the configured operation limit.', { maximumOperations });
            }
            return null;
          }
        }
        function inspectChain(input) {
          const names = input.slice();
          if (['globalThis', 'window'].includes(names[0])) names.shift();
          const root = names.shift();
          if (root === 'decodeURIComponent') shadowed = true;
          if (root === 'String' && (!names.length || names[0] === null || names[0] === 'fromCharCode')) shadowed = true;
          if (['Function', 'Object'].includes(root) && names[0] === 'prototype' && (!names[1] || propertyNames.has(names[1]))) unsafeProperty = true;
        }
        function inspectIntrinsicWrite(target) {
          if (within(target, path)) return;
          const chain = intrinsicChain(target);
          if (chain) inspectChain(chain);
        }
        // Cache/helper properties must remain private. An escaped function or
        // an observed/reassigned property could change subsequent calls.
        const seen = new Set();
        const privateReferences = current => {
          if (!current || seen.size > 80 || seen.has(current) || !current.constant) return false;
          seen.add(current);
          for (const reference of current.referencePaths) {
            if (within(reference, path)) continue;
            if (reference.parentPath.isCallExpression() && reference.key === 'callee') continue;
            if (reference.parentPath.isVariableDeclarator() && reference.key === 'init' && reference.parentPath.get('id').isIdentifier()) {
              if (privateReferences(reference.scope.getBinding(reference.parentPath.node.id.name))) continue;
            }
            return false;
          }
          return true;
        };
        if (!alphabet || shadowed || unsafeProperty || !privateReferences(binding)) {
          warn('UNSUPPORTED_STRING_DECODER', 'Cached direct-array decoder has shadowed intrinsics or observable helper/cache properties.', { name: binding.identifier.name });
          return;
        }
        decoders.set(binding, { ...found, path, binding, aliases: seen, variant: 'base64', alphabet, cache: new Map(), directCached: true, base64Mode: 'byte-loop' });
        protectedFunctions.add(path);
        return;
      }
      let exactResult = true, resultReturns = 0;
      found.owner.traverse({
        Function(inner) { inner.skip(); },
        ReturnStatement(statement) {
          resultReturns++;
          const result = statement.get('argument');
          if (result !== found.lookup && (!result.isIdentifier() || !resultBinding || result.scope.getBinding(result.node.name) !== resultBinding)) exactResult = false;
        }
      });
      if (!exactResult || !resultReturns) {
        warn('UNSUPPORTED_STRING_DECODER', 'String table lookup has a custom return transformation.', { name: binding.identifier.name });
        return;
      }
      if (found.owner !== path) {
        let outerReturnValid = true, outerReturns = 0;
        path.traverse({
          Function(inner) { inner.skip(); },
          ReturnStatement(statement) {
            outerReturns++;
            let result = statement.get('argument');
            if (result.isSequenceExpression()) result = result.get('expressions').slice(-1)[0];
            if (!result.isCallExpression() || !result.get('callee').isIdentifier() || result.scope.getBinding(result.node.callee.name) !== binding) outerReturnValid = false;
            else if (result.node.arguments.length !== path.node.params.length || !result.get('arguments').every((argument, index) => argument.isIdentifier() && t.isIdentifier(path.node.params[index]) && argument.scope.getBinding(argument.node.name) === path.scope.getBinding(path.node.params[index].name))) outerReturnValid = false;
          }
        });
        if (!outerReturnValid || !outerReturns) {
          warn('UNSUPPORTED_STRING_DECODER', 'Self-redefining decoder has a custom outer return transformation.', { name: binding.identifier.name });
          return;
        }
      }
      let externalEffect = false;
      const localTarget = target => {
        if (target.isIdentifier()) {
          const targetBinding = target.scope.getBinding(target.node.name);
          return targetBinding === binding || !!(targetBinding && within(targetBinding.path, path));
        }
        if (target.isMemberExpression()) {
          let object = target.get('object');
          while (object.isMemberExpression()) object = object.get('object');
          if (object.isThisExpression()) return object.getFunctionParent() !== path && object.getFunctionParent() !== found.owner;
          return localTarget(object);
        }
        return false;
      };
      path.traverse({
        AssignmentExpression(assignment) { if (!localTarget(assignment.get('left'))) externalEffect = true; },
        UpdateExpression(update) { if (!localTarget(update.get('argument'))) externalEffect = true; },
        CallExpression(call) {
          const callee = call.get('callee');
          if (callee.isIdentifier()) {
            const calledBinding = callee.scope.getBinding(callee.node.name);
            const intrinsic = !calledBinding && ['decodeURIComponent', 'Boolean', 'String', 'Number', 'parseInt'].includes(callee.node.name);
            if (!intrinsic && calledBinding !== binding && !providers.has(calledBinding) && !(calledBinding && within(calledBinding.path, path))) externalEffect = true;
          } else if (callee.isMemberExpression()) {
            let object = callee.get('object');
            while (object.isMemberExpression()) object = object.get('object');
            if (object.isIdentifier() && !localTarget(object) && !(!object.scope.getBinding(object.node.name) && ['String', 'Math', 'Object'].includes(object.node.name))) externalEffect = true;
          } else if (!callee.isFunction()) externalEffect = true;
        }
      });
      if (externalEffect) {
        warn('UNSUPPORTED_STRING_DECODER', 'String decoder has effects outside its recognized local implementation.', { name: binding.identifier.name });
        return;
      }
      let alphabet = null, uri = false, xor = false, modulus256 = false;
      path.traverse({
        StringLiteral(literal) {
          const value = literal.node.value;
          if (isAlphabet(value)) alphabet = value;
        },
        Identifier(identifier) { if (identifier.node.name === 'decodeURIComponent') uri = true; },
        BinaryExpression(expression) { if (expression.node.operator === '^') xor = true; if (expression.node.operator === '%' && numeric(expression.node.right) === 256) modulus256 = true; }
      });
      const variant = alphabet || uri ? (xor && modulus256 ? 'rc4' : 'base64') : 'plain';
      if (variant !== 'plain') {
        const helpers = new Map(), properties = new Map();
        path.traverse({
          Function(helper) {
            if (helper === path) return;
            const helperBinding = functionBinding(helper);
            if (!helperBinding || helperBinding === binding) return;
            let helperAlphabet = false, uriReturn = false, helperXor = false, helperModulus = false, identifierReturn = false;
            const methods = new Set(), calls = [];
            helper.traverse({
              Function(inner) { inner.skip(); },
              StringLiteral(literal) { if (literal.node.value === alphabet) helperAlphabet = true; },
              MemberExpression(member) { methods.add(memberName(member.node)); },
              BinaryExpression(expression) { if (expression.node.operator === '^') helperXor = true; if (expression.node.operator === '%' && numeric(expression.node.right) === 256) helperModulus = true; },
              CallExpression(call) { calls.push(call); },
              ReturnStatement(statement) {
                const argument = statement.get('argument');
                if (argument.isIdentifier()) identifierReturn = true;
                if (argument.isCallExpression() && argument.get('callee').isIdentifier({ name: 'decodeURIComponent' }) && !argument.scope.getBinding('decodeURIComponent')) uriReturn = true;
              }
            });
            helpers.set(helperBinding, { base64: helperAlphabet && uriReturn && ['charAt', 'indexOf', 'fromCharCode'].every(method => methods.has(method)), rc4: helperXor && helperModulus && identifierReturn && methods.has('charCodeAt'), calls });
          },
          AssignmentExpression(assignment) {
            const left = assignment.get('left'), right = assignment.get('right');
            if (!left.isMemberExpression() || !t.isIdentifier(left.node.object) || left.scope.getBinding(left.node.object.name) !== binding || !right.isIdentifier()) return;
            const property = memberName(left.node);
            if (property) properties.set(property, right.scope.getBinding(right.node.name));
          }
        });
        const calledHelper = callee => {
          if (callee.isIdentifier()) return helpers.get(callee.scope.getBinding(callee.node.name));
          if (callee.isMemberExpression() && t.isIdentifier(callee.node.object) && callee.scope.getBinding(callee.node.object.name) === binding) return helpers.get(properties.get(memberName(callee.node)));
          return null;
        };
        let transformation = false;
        if (resultBinding) for (const write of resultBinding.constantViolations) {
          if (!write.isAssignmentExpression() || !write.get('right').isCallExpression()) continue;
          const call = write.get('right'), first = call.get('arguments.0');
          if (!first || !first.isIdentifier() || first.scope.getBinding(first.node.name) !== resultBinding) continue;
          const helper = calledHelper(call.get('callee'));
          if (helper && (variant === 'base64' ? helper.base64 : helper.rc4 && helper.calls.some(nested => { const nestedHelper = calledHelper(nested.get('callee')); return nestedHelper && nestedHelper.base64; }))) transformation = true;
        }
        if (!transformation) {
          warn('UNSUPPORTED_STRING_DECODER', 'Encoded lookup is not processed by a recognized base64/RC4 helper.', { name: binding.identifier.name });
          return;
        }
      }
      if (variant === 'plain') {
        let unsupported = false;
        if (resultBinding && !safeBinding(resultBinding)) unsupported = true;
        path.traverse({
          VariableDeclarator(declaration) {
            const init = declaration.get('init');
            if (!init.node || init.isLiteral()) return;
            if (init.isIdentifier()) {
              const source = init.scope.getBinding(init.node.name);
              if (source && within(source.path, path)) return;
            }
            if (init === found.lookup) return;
            if (init.isCallExpression() && init.get('callee').isIdentifier() && providers.has(init.scope.getBinding(init.node.callee.name))) return;
            unsupported = true;
          },
          AssignmentExpression(assignment) {
            const left = assignment.get('left');
            if (!left.isIdentifier()) { unsupported = true; return; }
            const targetBinding = left.scope.getBinding(left.node.name);
            if (targetBinding === binding && assignment.get('right').isFunction()) return;
            if (targetBinding && targetBinding.kind === 'param' && assignment.node.operator === '=' && t.isBinaryExpression(assignment.node.right) && ['-', '+'].includes(assignment.node.right.operator) && t.isIdentifier(assignment.node.right.left, { name: left.node.name }) && numeric(assignment.node.right.right) !== null) return;
            unsupported = true;
          },
          ExpressionStatement(statement) { if (!statement.get('expression').isAssignmentExpression()) unsupported = true; },
          CallExpression(call) {
            if (!call.get('callee').isIdentifier()) { unsupported = true; return; }
            const calledBinding = call.scope.getBinding(call.node.callee.name);
            if (calledBinding !== binding && !providers.has(calledBinding)) unsupported = true;
          },
          NewExpression() { unsupported = true; },
          ThrowStatement() { unsupported = true; },
          IfStatement() { unsupported = true; },
          Loop() { unsupported = true; },
          UpdateExpression() { unsupported = true; }
        });
        if (unsupported) {
          warn('UNSUPPORTED_STRING_DECODER', 'Plain string decoder contains calls outside the recognized table lookup pattern.', { name: binding.identifier.name });
          return;
        }
      }
      if (variant !== 'plain' && !alphabet) {
        warn('UNSUPPORTED_STRING_DECODER', 'Encoded string decoder has no recognizable static base64 alphabet.', { name: binding.identifier.name });
        return;
      }
      decoders.set(binding, { ...found, path, binding, variant, alphabet: alphabet || DEFAULT_ALPHABET, cache: new Map() });
      protectedFunctions.add(path);
    }
  });

  for (const [binding, provider] of providers) if (provider.directArray &&
      ![...decoders.values()].some(decoder => decoder.provider === provider)) providers.delete(binding);

  function decode(descriptor, args, rotations) {
    budget();
    const { provider } = descriptor;
    if (!provider.usable) return UNKNOWN;
    if (provider.directArray && activeCallPosition !== null && provider.path.node.start != null && activeCallPosition < provider.path.node.start) return UNKNOWN;
    if (!rotations && activeCallPosition !== null && provider.rotationPosition != null && activeCallPosition < provider.rotationPosition) return UNKNOWN;
    const argument = args[descriptor.argumentIndex];
    if (typeof argument !== 'number' && typeof argument !== 'string') return UNKNOWN;
    let indexValue = argument;
    for (const transformation of descriptor.transformations) indexValue = transformation.operator === '+' ? indexValue + transformation.value : indexValue - transformation.value;
    if (typeof indexValue === 'string' && String(Number(indexValue)) !== indexValue) return UNKNOWN;
    const index = Number(indexValue);
    if (!Number.isInteger(index) || index < 0 || index >= provider.values.length) return UNKNOWN;
    const rotation = rotations && rotations.has(provider) ? rotations.get(provider) : provider.rotation;
    const sourceIndex = (index + rotation) % provider.values.length;
    const value = provider.values[sourceIndex];
    const lengthLimit = () => {
      if (!descriptor.lengthWarning) {
        descriptor.lengthWarning = true;
        warn('STRING_DECODER_LENGTH_LIMIT', 'String decoder call was preserved because its encoded or decoded string exceeds the configured length limit.', { name: descriptor.binding.identifier.name, maximumLength: maximumStringLength });
      }
      return UNKNOWN;
    };
    if (value.length > maximumStringLength) return lengthLimit();
    const key = args[descriptor.argumentIndex + 1];
    const cacheKey = JSON.stringify([sourceIndex, key]);
    if (descriptor.cache.has(cacheKey)) { decodedDuringEvaluation = true; return descriptor.cache.get(cacheKey); }
    let result;
    if (descriptor.variant === 'plain') result = value;
    else if (descriptor.variant === 'base64') result = decodeBase64(value, descriptor.alphabet, budget, descriptor.base64Mode);
    else result = decodeRc4(value, key, descriptor.alphabet, budget);
    if (result.length > maximumStringLength) return lengthLimit();
    descriptor.cache.set(cacheKey, result);
    decodedDuringEvaluation = true;
    return result;
  }


  function resolve(path, env, rotations, stack, depth) {
    if (!path.isIdentifier()) return null;
    const binding = path.scope.getBinding(path.node.name);
    if (!binding) return null;
    if (dynamicScope && (dynamicScope.affectsBinding(binding) || dynamicScope.affectsStaticReference(path))) return null;
    if (decoders.has(binding)) {
      if (!binding.path.isFunctionDeclaration() && binding.path.node.start != null && path.node.start != null && binding.path.node.start >= path.node.start) return null;
      return { decoder: decoders.get(binding) };
    }
    if (depth > 80 || stack.has(binding) || !safeBinding(binding, path)) return null;
    if (binding.path.isVariableDeclarator() && binding.path.get('init').isIdentifier()) {
      const next = new Set(stack); next.add(binding);
      return resolve(binding.path.get('init'), env, rotations, next, depth + 1);
    }
    const fn = binding.path.isFunctionDeclaration() ? binding.path : binding.path.isVariableDeclarator() ? binding.path.get('init') : null;
    if (fn && fn.isFunction() && !fn.node.async && !fn.node.generator && fn.node.params.every(parameter => t.isIdentifier(parameter))) return { wrapper: fn, binding };
    return null;
  }

  function evaluate(path, env = new Map(), rotations = null, stack = new Set(), depth = 0) {
    budget();
    if (!path || !path.node || depth > 80) return UNKNOWN;
    const node = path.node;
    const ev = child => evaluate(child, env, rotations, stack, depth + 1);
    if (path.isStringLiteral() || path.isNumericLiteral() || path.isBooleanLiteral()) return node.value;
    if (path.isNullLiteral()) return null;
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(node.name);
      if (binding && env.has(binding)) return env.get(binding);
      if (!binding && node.name === 'undefined') return undefined;
      if (!binding || stack.has(binding) || !safeBinding(binding, path) || !binding.path.isVariableDeclarator()) return UNKNOWN;
      const next = new Set(stack); next.add(binding);
      return evaluate(binding.path.get('init'), env, rotations, next, depth + 1);
    }
    if (path.isUnaryExpression()) {
      const value = ev(path.get('argument'));
      if (value === UNKNOWN) return UNKNOWN;
      switch (node.operator) { case '+': return +value; case '-': return -value; case '!': return !value; case '~': return ~value; case 'void': return undefined; default: return UNKNOWN; }
    }
    if (path.isBinaryExpression()) {
      const left = ev(path.get('left')), right = ev(path.get('right'));
      if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
      switch (node.operator) {
        case '+': return left + right; case '-': return left - right; case '*': return left * right; case '/': return left / right; case '%': return left % right;
        case '<<': return left << right; case '>>': return left >> right; case '>>>': return left >>> right; case '^': return left ^ right; case '&': return left & right; case '|': return left | right;
        case '===': return left === right; case '!==': return left !== right; case '==': return left == right; case '!=': return left != right; // Match JS checksum coercion.
        case '<': return left < right; case '<=': return left <= right; case '>': return left > right; case '>=': return left >= right; default: return UNKNOWN;
      }
    }
    if (path.isConditionalExpression()) { const test = ev(path.get('test')); return test === UNKNOWN ? UNKNOWN : ev(path.get(test ? 'consequent' : 'alternate')); }
    if (path.isCallExpression() && path.get('callee').isIdentifier()) {
      const callee = path.get('callee');
      const args = path.get('arguments').map(ev);
      if (args.some(value => value === UNKNOWN)) return UNKNOWN;
      const name = callee.node.name;
      if (!callee.scope.getBinding(name)) {
        if (name === 'parseInt') return parseInt(args[0], args[1]);
        if (name === 'Number') return Number(args[0]);
        if (name === 'String') return String(args[0]);
        return UNKNOWN;
      }
      const target = resolve(callee, env, rotations, stack, depth + 1);
      if (!target) return UNKNOWN;
      if (target.decoder) return decode(target.decoder, args, rotations);
      if (stack.has(target.binding)) return UNKNOWN;
      const fn = target.wrapper, local = new Map(env), next = new Set(stack);
      next.add(target.binding);
      fn.get('params').forEach((parameter, index) => local.set(parameter.scope.getBinding(parameter.node.name), args[index]));
      if (!fn.get('body').isBlockStatement()) return evaluate(fn.get('body'), local, rotations, next, depth + 1);
      for (const statement of fn.get('body.body')) {
        if (statement.isReturnStatement()) return evaluate(statement.get('argument'), local, rotations, next, depth + 1);
        if (!statement.isVariableDeclaration()) return UNKNOWN;
        for (const declaration of statement.get('declarations')) {
          if (!declaration.get('id').isIdentifier()) return UNKNOWN;
          const binding = declaration.scope.getBinding(declaration.node.id.name);
          if (!binding || !binding.constant) return UNKNOWN;
          if (declaration.get('init').isIdentifier() && resolve(declaration.get('init'), local, rotations, next, depth + 1)) continue;
          const value = evaluate(declaration.get('init'), local, rotations, next, depth + 1);
          if (value === UNKNOWN) return UNKNOWN;
          local.set(binding, value);
        }
      }
    }
    return UNKNOWN;
  }

  const rotations = new Set(), rotatedProviders = new Set(), providerRotations = new Map();
  traverse(ast, { CallExpression(path) {
    const callee = path.get('callee');
    if (!callee.isFunctionExpression() && !callee.isArrowFunctionExpression()) return;
    const args = path.get('arguments');
    let provider = null, parameterIndex = -1;
    args.forEach((argument, index) => {
      if (argument.isIdentifier() && providers.has(argument.scope.getBinding(argument.node.name))) { provider = providers.get(argument.scope.getBinding(argument.node.name)); parameterIndex = index; }
    });
    if (!provider) return;
    const providerParameter = callee.node.params[parameterIndex];
    if (!t.isIdentifier(providerParameter)) return;
    const providerBinding = callee.scope.getBinding(providerParameter.name);
    let rotating = false, comparison = null;
    callee.traverse({
      CallExpression(call) {
        if (memberName(call.node.callee) !== 'push' || call.node.arguments.length !== 1) return;
        const shift = call.node.arguments[0];
        if (!t.isCallExpression(shift) || memberName(shift.callee) !== 'shift' || !t.isIdentifier(call.node.callee.object) || !t.isIdentifier(shift.callee.object)) return;
        const binding = call.scope.getBinding(call.node.callee.object.name);
        if (!binding || binding !== call.scope.getBinding(shift.callee.object.name) || !binding.path.isVariableDeclarator()) return;
        const init = binding.path.get('init');
        if (init.isCallExpression() && init.get('callee').isIdentifier() && init.scope.getBinding(init.node.callee.name) === providerBinding) rotating = true;
      },
      IfStatement(statement) {
        const consequent = statement.get('consequent');
        const breaks = consequent.isBreakStatement() || (consequent.isBlockStatement() && consequent.node.body.some(item => t.isBreakStatement(item)));
        if (breaks && statement.get('test').isBinaryExpression() && ['===', '=='].includes(statement.node.test.operator)) comparison = statement.get('test');
      }
    });
    if (!rotating) return;
    rotations.add(path);
    if (!providerRotations.has(provider)) providerRotations.set(provider, []);
    providerRotations.get(provider).push(path.node);
    if (!provider.memoized) {
      provider.usable = false;
      warn('UNSUPPORTED_STRING_ROTATION', 'Rotation does not use a recognized memoized table provider.');
      return;
    }
    if (rotatedProviders.has(provider)) {
      provider.usable = false;
      warn('UNSUPPORTED_STRING_ROTATION', 'Multiple rotations of the same shared string table were preserved.');
      return;
    }
    rotatedProviders.add(provider);
    provider.rotationPosition = path.node.start;
    if (!comparison) {
      provider.usable = false;
      warn('UNSUPPORTED_STRING_ROTATION', 'String table rotation has no supported equality checksum.', { provider: provider.functionPath.node.id && provider.functionPath.node.id.name });
      return;
    }
    const env = new Map();
    callee.get('params').forEach((parameter, index) => {
      if (parameter.isIdentifier() && index !== parameterIndex && args[index]) env.set(parameter.scope.getBinding(parameter.node.name), evaluate(args[index]));
    });
    let solved = false, unsupported = false;
    const limit = Math.min(provider.values.length, maximumRotations);
    for (let rotation = 0; rotation < limit; rotation++) {
      try {
        const result = evaluate(comparison, env, new Map([[provider, rotation]]));
        if (result === UNKNOWN) { unsupported = true; break; }
        if (result === true) { provider.rotation = rotation; solved = true; break; }
      } catch (error) {
        if (error.message === 'STATIC_OPERATION_LIMIT') { stopped = true; break; }
        // Bad UTF-8 / invalid RC4 keys at the wrong rotation are expected.
      }
    }
    if (!solved) {
      provider.usable = false;
      warn(stopped ? 'STRING_DECODER_OPERATION_LIMIT' : unsupported ? 'UNSUPPORTED_STRING_ROTATION' : 'STRING_ROTATION_UNRESOLVED', 'String table was preserved because its rotation could not be proved within static limits.', { length: provider.values.length, attempts: limit });
    }
  } });

  // An array returned to unknown code can be changed before a later lookup.
  for (const [binding, provider] of providers) {
    for (const reference of binding.referencePaths) {
      if (within(reference, provider.functionPath)) continue;
      if ([...decoders.values()].some(decoder => decoder.provider === provider && within(reference, decoder.path))) continue;
      if ([...rotations].some(rotation => within(reference, rotation))) continue;
      provider.usable = false;
      warn('UNSUPPORTED_STRING_TABLE_ESCAPE', 'String table is referenced outside recognized decoders and rotation.', { name: binding.identifier.name });
      break;
    }
  }

  // First recognize the decoder family without changing source. This resolver
  // lets the narrowly validated JSON2 grammar prove its computed method names;
  // arbitrary eval still blocks every table/decoder binding it can observe.
  const preflightUsability = new Map([...providers.values()].map(provider => [provider, provider.usable]));
  const resolveCandidateString = path => {
    const previousScope = dynamicScope, previousPosition = activeCallPosition;
    const previousUsability = new Map([...providers.values()].map(provider => [provider, provider.usable]));
    try {
      // This read-only proof hook describes the recognized static candidate;
      // deciding whether dynamic scope permits rewriting is the caller's job.
      dynamicScope = null;
      for (const [provider, usable] of preflightUsability) provider.usable = usable;
      activeCallPosition = path && path.node ? path.node.start : null;
      const value = evaluate(path);
      return typeof value === 'string' ? value : undefined;
    } catch (error) {
      if (error.message === 'STATIC_OPERATION_LIMIT' && !stopped) {
        stopped = true;
        warn('STRING_DECODER_OPERATION_LIMIT', 'String decoder analysis stopped at the configured operation limit.', { maximumOperations });
      }
      return undefined;
    } finally {
      dynamicScope = previousScope;
      activeCallPosition = previousPosition;
      for (const [provider, usable] of previousUsability) provider.usable = usable;
    }
  };
  let layeredResolver = null;
  const resolveString = path => {
    const candidate = resolveCandidateString(path);
    if (typeof candidate === 'string') return candidate;
    if (!layeredResolver && !stopped) layeredResolver = require('./substituted-hex').createStaticResolver(ast, { options }, resolveCandidateString);
    const value = layeredResolver && layeredResolver(path);
    return typeof value === 'string' ? value : undefined;
  };
  if (context.state) context.state.set('string-arrays:resolve-string', resolveString);
  dynamicScope = analyzeDynamicScope(ast, { context, resolveString, ignoreEval: path => isRestrictedJsonEval(path, resolveString) });
  let blockedDynamic = false;
  for (const descriptor of decoders.values()) if (dynamicScope.affectsBinding(descriptor.binding) || dynamicScope.affectsBinding(descriptor.provider.binding) ||
      descriptor.aliases && [...descriptor.aliases].some(binding => dynamicScope.affectsBinding(binding))) {
    descriptor.provider.usable = false;
    blockedDynamic = true;
  }
  if (blockedDynamic) warn('UNSUPPORTED_DYNAMIC_SCOPE', 'String decoder families visible to direct eval or with were preserved.');

  let replacements = 0;
  if (!stopped) traverse(ast, { CallExpression: { exit(path) {
    if (stopped || !path.get('callee').isIdentifier()) return;
    for (const fn of protectedFunctions) if (within(path, fn)) return;
    for (const rotation of rotations) if (within(path, rotation)) return;
    const target = resolve(path.get('callee'), new Map(), null, new Set(), 0);
    if (!target) return;
    try {
      activeCallPosition = path.node.start == null ? null : path.node.start;
      decodedDuringEvaluation = false;
      const result = evaluate(path);
      if (typeof result === 'string' && decodedDuringEvaluation) { path.replaceWith(t.stringLiteral(result)); replacements++; }
    } catch (error) {
      if (error.message === 'STATIC_OPERATION_LIMIT') {
        stopped = true;
        warn('STRING_DECODER_OPERATION_LIMIT', 'String decoding stopped at the configured operation limit.', { maximumOperations });
      }
    }
  } } });
  if (context.state) context.state.set('string-arrays:families', {
    ast,
    families: [...providers.entries()].map(([binding, provider]) => ({
      providerNode: provider.functionPath.node,
      providerName: binding.identifier.name,
      decoderNodes: [...decoders.values()].filter(decoder => decoder.provider === provider).map(decoder => decoder.path.node),
      rotationNodes: providerRotations.get(provider) || [],
      usable: provider.usable,
    })).filter(family => family.decoderNodes.length),
  });
  return replacements;
}

module.exports = { name: 'decode-string-arrays', description: 'Statically decode recognized plain, base64 and RC4 string arrays with bounded rotation solving.', run };
