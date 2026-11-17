'use strict';

const t = require('@babel/types');

const DATA_ONLY_ASSUMPTIONS = Object.freeze([
  'The input coerces to exactly one data literal expression: strings, numbers, booleans, null, arrays and object property values.',
  'The input contains no identifier references, calls, functions, accessors, computed keys, spreads, assignments or additional statements.',
  'The unbound eval name denotes the host intrinsic eval function.',
]);

function unwrap(path) {
  while (path && path.isParenthesizedExpression()) path = path.get('expression');
  return path;
}

function staticString(path, resolveString) {
  path = unwrap(path);
  if (path.isStringLiteral()) return path.node.value;
  const value = resolveString(path);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Recognize a legacy data-parser *shape*, without claiming the data is safe.
 * A network response, a typeof-string guard, and parentheses are not proofs of
 * a data-only grammar. Unlike restricted-json-eval, this module never supplies
 * a default dynamic-scope exemption and never executes the input.
 *
 * resolveString is an optional caller-provided, effect-free static proof for
 * obfuscated literal prefixes. No value is guessed from identifier spelling.
 * inputPath is retained so a caller can preserve its original evaluation.
 */
function classifyDataEval(call, options = {}) {
  if (!call || !call.isCallExpression() || call.node.optional || call.node.arguments.length !== 1) return null;
  const callee = unwrap(call.get('callee'));
  if (!callee.isIdentifier({ name: 'eval' }) || call.scope.getBinding('eval') || call.findParent(path => path.isWithStatement())) return null;
  const argument = unwrap(call.get('arguments.0'));
  if (!argument.isBinaryExpression({ operator: '+' })) return null;
  const resolveString = typeof options.resolveString === 'function' ? options.resolveString : () => undefined;
  const value = path => staticString(path, resolveString);

  let kind, inputPath, introducedNames;
  const left = unwrap(argument.get('left'));
  if (value(argument.get('right')) === ')' && left.isBinaryExpression({ operator: '+' }) && value(left.get('left')) === '(') {
    kind = 'parenthesized-expression';
    inputPath = left.get('right');
    introducedNames = [];
  } else {
    const prefix = value(argument.get('left'));
    const declaration = typeof prefix === 'string' && /^var\s+([^\s=]+)\s*=\s*$/.exec(prefix);
    if (!declaration || !t.isValidIdentifier(declaration[1]) || ['eval', 'arguments'].includes(declaration[1])) return null;
    // Only a standalone statement has an unused eval completion value. A
    // normalization to an explicit var declaration is not safe in a return,
    // sequence, conditional or assignment without additional reasoning.
    if (!call.parentPath.isExpressionStatement()) return null;
    kind = 'variable-declaration';
    inputPath = argument.get('right');
    introducedNames = [declaration[1]];
  }
  if (!inputPath.node || inputPath.isSpreadElement()) return null;
  return {
    kind,
    inputPath,
    introducedNames,
    proven: false,
    assumptions: [...DATA_ONLY_ASSUMPTIONS],
    // This is the whole enclosing variable environment in sloppy direct eval,
    // not just the lexical block containing the statement.
    requiresMaterializedBindings: introducedNames.length > 0,
  };
}

/**
 * Explicit opt-in policy for callers that already know their data contract.
 * Pass its ignoreEval hook to analyzeDynamicScope only in that opt-in mode.
 * Unknown eval shapes always remain dynamic, even when assumeDataOnly is true.
 *
 * `eval('var x=' + input)` still introduces/changes x. It must first be made
 * explicit in the AST by a separate transform; this hook deliberately never
 * exempts such sites. Merely promising to preserve the spelling is not enough
 * for alias propagation, constant analysis or dead-code removal to be sound.
 */
function createDataEvalPolicy(options = {}) {
  const assumptions = [];
  const reported = new WeakSet();
  const classify = path => classifyDataEval(path, options);
  const ignoreEval = path => {
    if (options.assumeDataOnly !== true) return false;
    const classification = classify(path);
    if (!classification || classification.requiresMaterializedBindings) return false;
    if (!reported.has(path.node)) {
      reported.add(path.node);
      const diagnostic = {
        code: 'ASSUMED_DATA_EVAL',
        kind: classification.kind,
        proven: false,
        location: path.node.loc ? { line: path.node.loc.start.line, column: path.node.loc.start.column } : null,
        assumptions: [...classification.assumptions],
      };
      assumptions.push(diagnostic);
      if (typeof options.onAssumption === 'function') options.onAssumption(diagnostic, path);
    }
    return true;
  };
  return { classify, ignoreEval, assumptions };
}

module.exports = { classifyDataEval, createDataEvalPolicy, DATA_ONLY_ASSUMPTIONS };
