'use strict';

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { isRestrictedJsonEval } = require('../analysis/restricted-json-eval');
const { classifyDataEval } = require('../analysis/parenthesized-data-eval');

function inside(path, ancestor) {
  for (let current = path; current; current = current.parentPath) if (current === ancestor) return true;
  return false;
}

function variableScope(scope) {
  for (let current = scope; current; current = current.parent) {
    if (current.path.isFunction() || current.path.isProgram() || current.path.isStaticBlock()) return current;
  }
  return scope;
}

function scopeInside(scope, ancestor) {
  for (let current = scope; current; current = current.parent) if (current === ancestor) return true;
  return false;
}

function directEval(path) {
  // A locally bound name may still contain the intrinsic eval function. Do not
  // infer that shadowing alone makes eval(code) an ordinary, harmless call.
  if (!path.isCallExpression() || path.node.optional) return false;
  let callee = path.node.callee;
  while (t.isParenthesizedExpression(callee)) callee = callee.expression;
  return t.isIdentifier(callee, { name: 'eval' });
}

/**
 * Snapshot the dynamic identifier-resolution hazards of this AST. Rebuild the
 * snapshot after changing scopes; no cache is retained across pass iterations.
 *
 * affectsBinding(binding) protects reads, mutation and removal of an existing
 * binding, including eval in a nested closure that can see its lexical name.
 * affectsPath(path) protects a replacement/insertion site from with lookup and
 * the possible local names introduced/observed by eval in its variable scope.
 * affectsRegion(path) additionally rejects hazards nested inside a moved region.
 * For a transform that moves a binding and rewrites uses, check the binding and
 * every destination path, rather than treating any one query as a full proof.
 *
 * ignoreEval(path) is an explicit caller-supplied proof hook, not a heuristic.
 * Only an exact true ignores a site. For example, a caller can recognize a
 * narrowly validated JSON parser and pass path => provenNodes.has(path.node).
 * The only built-in exception is the strictly recognized, data-only JSON2
 * validation grammar. No argument or vendor code is executed by this analysis.
 *
 * context.options.assumeDataEval is a separate, explicitly unproven readable
 * analysis policy. Recognized declaration parsers keep their introduced-name
 * and variable-environment barriers. Never use affectsStaticReference as a
 * general replacement for affectsPath when moving or creating bindings.
 */
function analyzeDynamicScope(ast, options = {}) {
  const hazards = [], ignored = [], assumed = [];
  const context = options.context;
  const collect = (type, path) => {
    const hazard = { type, path, scope: path.scope, variableScope: variableScope(path.scope) };
    if (type === 'with') hazard.body = path.get('body');
    if (type === 'eval' && isRestrictedJsonEval(path)) {
      hazard.dataOnly = true;
      hazard.reason = 'restricted-json';
      ignored.push(hazard);
    } else if (type === 'eval' && typeof options.ignoreEval === 'function' && options.ignoreEval(path) === true) {
      hazard.reason = 'caller-proof';
      ignored.push(hazard);
    } else {
      const classification = type === 'eval' && context && context.options && context.options.profile === 'readable' &&
        context.options.assumeDataEval === true && classifyDataEval(path, { resolveString: options.resolveString });
      if (classification) {
        hazard.reason = 'assumed-data';
        hazard.assumedData = true;
        hazard.introducedNames = classification.introducedNames;
        assumed.push(hazard);
        if (typeof context.assumeDataEval === 'function') context.assumeDataEval(path, classification);
        // A declaration-form eval still mutates/introduces a named binding.
        // Retain its variable-environment/path barrier, but do not pretend
        // data can observe or mutate every unrelated decoder/helper name.
        if (hazard.introducedNames.length) hazards.push(hazard);
        else ignored.push(hazard);
      } else hazards.push(hazard);
    }
  };
  const visitor = {
    WithStatement(path) { collect('with', path); },
    CallExpression(path) { if (directEval(path)) collect('eval', path); },
  };
  if (ast && ast.node && typeof ast.traverse === 'function') {
    if (ast.isWithStatement()) collect('with', ast);
    else if (directEval(ast)) collect('eval', ast);
    ast.traverse(visitor);
  } else traverse(ast, visitor);

  const bindingHazards = binding => {
    if (!binding || !binding.identifier || !binding.path) return hazards.slice();
    const name = binding.identifier.name;
    return hazards.filter(hazard => {
      if (hazard.type === 'eval') return (!hazard.assumedData || hazard.introducedNames.includes(name)) && hazard.scope.getBinding(name) === binding;
      // Bindings declared within a with body, especially var initializers, can
      // be subject to its object environment. Keep those conservative too.
      return inside(binding.path, hazard.body) || hazard.body.scope.getBinding(name) === binding || binding.referencePaths.some(reference => inside(reference, hazard.body));
    });
  };
  const pathHazards = path => {
    if (!path || !path.node || !path.scope) return hazards.slice();
    return hazards.filter(hazard => hazard.type === 'with' ? inside(path, hazard.body) : scopeInside(path.scope, hazard.variableScope));
  };
  const regionHazards = path => {
    if (!path || !path.node) return hazards.slice();
    const affecting = new Set(pathHazards(path));
    return hazards.filter(hazard => affecting.has(hazard) || inside(hazard.path, path));
  };
  // This query is ONLY for resolving an existing identifier to a known, pure
  // static decoder. It is not permission to insert/move declarations, rename
  // a binding or inline an arbitrary expression. Assumed var-data eval can
  // introduce only its listed names; other eval and with remain full barriers.
  const staticReferenceHazards = path => pathHazards(path).filter(hazard =>
    !hazard.assumedData || !path.isIdentifier() || hazard.introducedNames.includes(path.node.name));
  return {
    hazards,
    ignored,
    assumed,
    restricted: ignored.filter(hazard => hazard.dataOnly),
    hasAny: hazards.length > 0,
    affectsBinding: binding => bindingHazards(binding).length > 0,
    affectsPath: path => pathHazards(path).length > 0,
    affectsRegion: path => regionHazards(path).length > 0,
    affectsStaticReference: path => staticReferenceHazards(path).length > 0,
    explainBinding: bindingHazards,
    explainPath: pathHazards,
    explainRegion: regionHazards,
    explainStaticReference: staticReferenceHazards,
  };
}

module.exports = { analyzeDynamicScope };
