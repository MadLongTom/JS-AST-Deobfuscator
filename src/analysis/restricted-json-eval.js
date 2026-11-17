'use strict';

const t = require('@babel/types');
const { jsonIntrinsicHazard } = require('./intrinsic-hazards');

// JSON2's parser validates a data-only grammar before evaluating its expression.
// This matcher does not execute the expression, replace the parser, or allow
// arbitrary guarded eval. All four regular expressions and their ordering must
// match, and the original input must have been coerced to a primitive string.
const GRAMMAR = {
  punctuation: /^[\],:{}\s]*$/.source,
  escapes: /\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g.source,
  values: /"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g.source,
  brackets: /(?:^|:|,)(?:\s*\[)+/g.source,
};

function isRestrictedJsonEval(call, resolveString = () => undefined) {
  if (!call.isCallExpression() || !call.get('callee').isIdentifier({ name: 'eval' }) ||
      call.scope.getBinding('eval') || call.node.arguments.length !== 1) return false;
  const owner = call.getFunctionParent();
  if (!owner || call.findParent(path => path.isWithStatement())) return false;
  const value = path => path.isStringLiteral() ? path.node.value : resolveString(path);
  const method = (path, name, arity) => {
    if (!path.isCallExpression() || path.node.optional || path.node.arguments.length !== arity) return false;
    const callee = path.get('callee');
    return callee.isMemberExpression() && !callee.node.optional && (
      !callee.node.computed && callee.get('property').isIdentifier({ name }) ||
      callee.node.computed && value(callee.get('property')) === name
    );
  };
  const source = call.get('arguments.0');
  if (!source.isBinaryExpression({ operator: '+' }) || value(source.get('right')) !== ')') return false;
  const prefix = source.get('left');
  if (!prefix.isBinaryExpression({ operator: '+' }) || value(prefix.get('left')) !== '(' || !prefix.get('right').isIdentifier()) return false;
  const input = prefix.get('right');
  const inputBinding = input.scope.getBinding(input.node.name);
  if (!inputBinding || inputBinding.scope !== owner.scope) return false;
  const isInput = path => path.isIdentifier() && path.scope.getBinding(path.node.name) === inputBinding;

  // Evaluation must be the first work performed after a successful guard. This
  // rejects mutations, callbacks or intervening control flow after validation.
  let first = call;
  if (first.parentPath.isAssignmentExpression({ operator: '=' }) && first.key === 'right') {
    const target = first.parentPath.get('left');
    const binding = target.isIdentifier() && target.scope.getBinding(target.node.name);
    if (!binding || binding.scope !== owner.scope) return false;
    first = first.parentPath;
  }
  if (first.parentPath.isSequenceExpression()) {
    if (first.key !== 0) return false;
    first = first.parentPath;
  }
  if (first.parentPath.isReturnStatement() || first.parentPath.isExpressionStatement()) first = first.parentPath;
  else if (first.parentPath.isVariableDeclarator() && first.key === 'init') {
    first = first.parentPath;
    if (first.key !== 0 || first.parentPath.node.declarations.length !== 1) return false;
    first = first.parentPath;
  } else return false;
  if (first.parentPath.isBlockStatement()) {
    if (first.key !== 0 || first.parentPath.node.directives.length) return false;
    first = first.parentPath;
  }
  const guard = first.parentPath;
  if (!guard.isIfStatement() || first.key !== 'consequent' || guard.getFunctionParent() !== owner) return false;
  const tests = guard.get('test').isSequenceExpression() ? guard.get('test.expressions') : [guard.get('test')];
  const test = tests[tests.length - 1];
  if (!method(test, 'test', 1)) return false;

  function regex(path, pattern, flags) {
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding || !binding.constant || binding.constantViolations.length || !binding.path.isVariableDeclarator()) return false;
      // The guard is the only consumer: no escaped RegExp or mutated methods.
      if (binding.referencePaths.length !== 1 || binding.referencePaths[0].node !== path.node) return false;
      path = binding.path.get('init');
    }
    return path.isRegExpLiteral() && path.node.pattern === pattern && path.node.flags === flags;
  }
  if (!regex(test.get('callee.object'), GRAMMAR.punctuation, '')) return false;
  let chain = test.get('arguments.0');
  for (const [pattern, replacement] of [[GRAMMAR.brackets, ''], [GRAMMAR.values, ']'], [GRAMMAR.escapes, '@']]) {
    if (!method(chain, 'replace', 2) || !regex(chain.get('arguments.0'), pattern, 'g') || value(chain.get('arguments.1')) !== replacement) return false;
    chain = chain.get('callee.object');
  }
  if (!isInput(chain)) return false;

  // JSON2 normalizes troublesome characters after String(input). Requiring this
  // coercion in the guard's first expression prevents an object's custom
  // replace/toString methods from validating one value and evaluating another.
  const coercion = tests[0];
  if (!coercion.isAssignmentExpression({ operator: '=' }) || !isInput(coercion.get('left'))) return false;
  const conversion = coercion.get('right');
  if (!conversion.isCallExpression() || !conversion.get('callee').isIdentifier({ name: 'String' }) ||
      conversion.scope.getBinding('String') || conversion.node.arguments.length !== 1 || !isInput(conversion.get('arguments.0'))) return false;
  if (tests.length !== 2) {
    if (tests.length !== 4) return false;
    const reset = tests[1];
    const normalize = tests[2];
    if (!reset.isAssignmentExpression({ operator: '=' }) || !reset.get('right').isNumericLiteral({ value: 0 })) return false;
    const lastIndex = reset.get('left');
    if (!lastIndex.isMemberExpression() || (lastIndex.node.computed ? value(lastIndex.get('property')) !== 'lastIndex' : !lastIndex.get('property').isIdentifier({ name: 'lastIndex' }))) return false;
    const chars = lastIndex.get('object');
    const charsBinding = chars.isIdentifier() && chars.scope.getBinding(chars.node.name);
    if (!charsBinding || !charsBinding.constant || !charsBinding.path.isVariableDeclarator() || !charsBinding.path.get('init').isRegExpLiteral() || charsBinding.referencePaths.length !== 3) return false;
    const sameChars = path => path.isIdentifier() && path.scope.getBinding(path.node.name) === charsBinding;
    if (!normalize.isLogicalExpression({ operator: '&&' }) || !method(normalize.get('left'), 'test', 1) || !sameChars(normalize.get('left.callee.object')) || !isInput(normalize.get('left.arguments.0'))) return false;
    const assignment = normalize.get('right');
    if (!assignment.isAssignmentExpression({ operator: '=' }) || !isInput(assignment.get('left'))) return false;
    const replacement = assignment.get('right');
    if (!method(replacement, 'replace', 2) || !isInput(replacement.get('callee.object')) || !sameChars(replacement.get('arguments.0'))) return false;
    const callback = replacement.get('arguments.1');
    if (!callback.isFunctionExpression() || callback.node.async || callback.node.generator || callback.node.params.length !== 1 || !callback.get('params.0').isIdentifier() || callback.node.body.directives.length || callback.node.body.body.length !== 1 || !callback.get('body.body.0').isReturnStatement()) return false;
    const character = callback.scope.getBinding(callback.node.params[0].name);
    const escaped = callback.get('body.body.0.argument');
    if (!escaped.isBinaryExpression({ operator: '+' }) || value(escaped.get('left')) !== '\\u') return false;
    const slice = escaped.get('right');
    const negativeFour = path => path.isUnaryExpression({ operator: '-' }) && path.get('argument').isNumericLiteral({ value: 4 });
    if (!method(slice, 'slice', 1) || !negativeFour(slice.get('arguments.0'))) return false;
    const padded = slice.get('callee.object');
    if (!padded.isBinaryExpression({ operator: '+' }) || value(padded.get('left')) !== '0000') return false;
    const hex = padded.get('right');
    if (!method(hex, 'toString', 1) || !hex.get('arguments.0').isNumericLiteral({ value: 16 })) return false;
    const charCode = hex.get('callee.object');
    if (!method(charCode, 'charCodeAt', 1) || !charCode.get('arguments.0').isNumericLiteral({ value: 0 }) || !charCode.get('callee.object').isIdentifier() || charCode.scope.getBinding(charCode.node.callee.object.name) !== character) return false;
  }

  // Explicit mutation/escape of intrinsics used by the proof invalidates it.
  // As elsewhere in the decoder, ambient host intrinsics are assumed intact.
  let program = call;
  while (program.parentPath) program = program.parentPath;
  return !jsonIntrinsicHazard(program, resolveString);
}

module.exports = { isRestrictedJsonEval };
