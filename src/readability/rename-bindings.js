'use strict';

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const { analyzeDynamicScope } = require('../passes/_utils');
const { findWebpackBundles } = require('./webpack');

const STATE_KEY = 'readability:renaming';
const OBFUSCATED = /^(?:_0x[\da-f]+|a\d*_0x[\da-f]+)$/i;
const UNINFORMATIVE = /^(?:[$_]?[A-Za-z])$/;
const RESERVED = new Set(['arguments', 'eval', 'undefined', 'NaN', 'Infinity', 'exports', 'default', 'prototype', 'constructor', '__proto__']);

function propertyName(node) {
  if (!t.isMemberExpression(node) && !t.isObjectProperty(node) && !t.isObjectMethod(node)) return null;
  const key = node.property || node.key;
  if (node.computed && !t.isStringLiteral(key)) return null;
  return t.isIdentifier(key) ? key.name : t.isStringLiteral(key) ? key.value : null;
}

function readableStem(value) {
  if (typeof value !== 'string' || !value || OBFUSCATED.test(value) || RESERVED.has(value)) return null;
  let stem = value.replace(/[^\p{L}\p{N}_$]+(.)?/gu, (_match, next) => next ? next.toUpperCase() : '');
  if (!stem || !t.isValidIdentifier(stem) || RESERVED.has(stem)) return null;
  if (stem.length === 1) stem += 'Value';
  return stem;
}

function functionLike(binding) {
  const path = binding.path;
  return path.isFunctionDeclaration() || path.isFunctionExpression() || path.isClassDeclaration() || path.isClassExpression()
    || path.isVariableDeclarator() && (path.get('init').isFunctionExpression() || path.get('init').isArrowFunctionExpression() || path.get('init').isClassExpression());
}

function anonymousFunctionOrClass(node) {
  while (t.isParenthesizedExpression(node)) node = node.expression;
  return t.isArrowFunctionExpression(node) || (t.isFunctionExpression(node) || t.isClassExpression(node)) && !node.id;
}

// A function can escape through an arbitrary call, object or closure before its
// name is inspected. Direct .name checks alone cannot prove a rename safe.
// Keep every binding whose spelling participates in explicit or inferred names,
// including later assignments and destructuring/parameter defaults.
function nameSensitiveBindings(ast) {
  const result = new Set();
  function target(path, value) {
    if (!path.isIdentifier() || !anonymousFunctionOrClass(value)) return;
    const binding = path.scope.getBinding(path.node.name);
    if (binding) result.add(binding);
  }
  traverse(ast, {
    VariableDeclarator(path) { target(path.get('id'), path.node.init); },
    AssignmentPattern(path) { target(path.get('left'), path.node.right); },
    AssignmentExpression(path) {
      if (['=', '||=', '&&=', '??='].includes(path.node.operator)) target(path.get('left'), path.node.right);
    },
  });
  return result;
}

function scopeInside(scope, ancestor) {
  for (let current = scope; current; current = current.parent) if (current === ancestor) return true;
  return false;
}

function inferredHint(binding, protocolRoles) {
  const path = binding.path;
  const hints = new Set();
  function add(value) { const stem = readableStem(value); if (stem) hints.add(stem); }
  if (path.isVariableDeclarator()) {
    const init = path.get('init');
    if (init.isMemberExpression()) add(propertyName(init.node));
    if (init.isCallExpression() && init.get('callee').isIdentifier() && init.node.arguments.length === 1) {
      const callee = init.scope.getBinding(init.node.callee.name);
      const argument = init.node.arguments[0];
      if (protocolRoles.get(callee) === 'require' && (t.isStringLiteral(argument) || t.isNumericLiteral(argument))) {
        add(`module_${argument.value}_exports`);
      }
    }
  }
  if ((path.isFunctionExpression() || path.isClassExpression()) && path.parentPath.isObjectProperty()) add(propertyName(path.parentPath.node));
  for (const reference of binding.referencePaths) {
    const parent = reference.parentPath;
    if (parent.isAssignmentExpression({ operator: '=' }) && reference.key === 'right' && t.isMemberExpression(parent.node.left)) {
      const left = parent.node.left;
      if (propertyName(left) === 'exports' && t.isIdentifier(left.object) && protocolRoles.get(parent.scope.getBinding(left.object.name)) === 'module') add('exportedValue');
      else add(propertyName(left));
    }
    if (parent.isObjectProperty() && reference.key === 'value' && !parent.node.shorthand) add(propertyName(parent.node));
  }
  return hints.size === 1 ? { name: [...hints][0], reason: 'static-property-evidence' } : null;
}

function neutralRole(binding) {
  if (binding.kind === 'param') return 'arg';
  if (binding.path.isClassDeclaration() || binding.path.isClassExpression()
    || binding.path.isVariableDeclarator() && binding.path.get('init').isClassExpression()) return 'Class';
  if (functionLike(binding)) return 'fn';
  return 'value';
}

/** Final readability stage. Renames lexical bindings, never property names. */
function run(ast, context = {}) {
  const report = {
    mode: 'evidence-and-neutral-labels', bindingsRenamed: 0, evidenceBased: 0, neutral: 0,
    webpackBundles: 0, webpackFactories: 0, renamed: [], skipped: [],
    assumptions: ['These labels are inferred from syntax or are neutral; original source names and business meanings are not recovered.',
      'Bindings that determine function/class names are retained; transformed source text and stack traces may still differ.'],
  };
  if (context.state) context.state.set(STATE_KEY, report);
  if (!context.options || context.options.profile !== 'readable') return 0;
  const dynamic = analyzeDynamicScope(ast, { context });
  const nameSensitive = nameSensitiveBindings(ast);
  const protocolHints = new Map(), protocolRoles = new Map();
  const bundles = findWebpackBundles(ast);
  function protocol(binding, name, reason) {
    if (binding) { protocolHints.set(binding, { name, reason }); protocolRoles.set(binding, name); }
  }
  for (const bundle of bundles) {
    protocol(bundle.tableBinding, 'modules', 'webpack-module-table');
    protocol(bundle.loaderBinding, 'webpackRequire', 'webpack-module-loader');
    // The descriptive label and the invocation role are intentionally distinct.
    // imported-module hints use the role even if the loader's name is retained.
    protocolRoles.set(bundle.loaderBinding, 'require');
    protocol(bundle.moduleBinding, 'moduleRecord', 'webpack-module-record');
    protocol(bundle.moduleIdBinding, 'moduleId', 'webpack-module-id');
    for (const binding of bundle.cacheBindings) protocol(binding, 'moduleCache', 'webpack-module-cache');
    for (const factory of bundle.factories) {
      factory.path.node.params.slice(0, 3).forEach((parameter, index) => {
        if (t.isIdentifier(parameter)) protocol(factory.path.scope.getBinding(parameter.name), ['module', 'exports', 'require'][index], 'webpack-factory-protocol');
      });
    }
  }
  report.webpackBundles = bundles.length;
  report.webpackFactories = bundles.reduce((sum, bundle) => sum + bundle.factories.length, 0);
  const bindings = [], seen = new Set();
  traverse(ast, { enter(path) {
    for (const binding of Object.values(path.scope.bindings)) if (!seen.has(binding)) { seen.add(binding); bindings.push(binding); }
  } });
  const forbiddenCache = new Map();
  function forbidden(scope) {
    if (!forbiddenCache.has(scope)) {
      const names = new Set();
      scope.path.traverse({ Identifier(path) {
        if (path.isReferencedIdentifier() || path.isBindingIdentifier()) names.add(path.node.name);
      }, JSXIdentifier(path) {
        // Capitalized JSX roots resolve lexically too; property and attribute
        // names may be included conservatively without changing their spelling.
        names.add(path.node.name);
      } });
      forbiddenCache.set(scope, names);
    }
    return forbiddenCache.get(scope);
  }
  function available(binding, name) {
    if (!t.isValidIdentifier(name) || ['eval', 'arguments', 'undefined', 'NaN', 'Infinity'].includes(name)) return false;
    if (binding.scope.hasBinding(name) || forbidden(binding.scope).has(name)) return false;
    return ![...binding.referencePaths, ...binding.constantViolations].some(path => path.scope.hasBinding(name));
  }
  const counters = new Map();
  const scheduled = [...bindings.filter(binding => protocolHints.has(binding)), ...bindings.filter(binding => !protocolHints.has(binding))];
  for (const binding of scheduled) {
    const from = binding.identifier.name;
    const hint = protocolHints.get(binding);
    if (!hint && !OBFUSCATED.test(from) && !UNINFORMATIVE.test(from)) continue;
    if (hint && hint.name === from) continue;
    const line = binding.identifier.loc && binding.identifier.loc.start.line;
    let skip = null;
    if (binding.scope.path.isProgram()) skip = 'program binding may be referenced by other scripts or exports';
    else if (dynamic.affectsBinding(binding) || [binding.path, ...binding.referencePaths, ...binding.constantViolations].some(path => dynamic.affectsPath(path))) skip = 'direct eval or with can resolve or capture this binding';
    // Even when eval cannot see the old name because it is shadowed, adding a
    // fresh name in an ancestor scope would make that name visible to eval.
    else if (dynamic.hazards.some(hazard => hazard.type === 'eval' && scopeInside(hazard.scope, binding.scope))) skip = 'a new binding name would become visible to direct eval';
    else if (from === 'eval' || from === 'arguments') skip = 'special identifier semantics';
    else if (binding.path.isFunctionDeclaration() || binding.path.isFunctionExpression() || binding.path.isClassDeclaration() || binding.path.isClassExpression() || nameSensitive.has(binding)) skip = 'binding determines a function/class name';
    if (skip) { report.skipped.push({ name: from, line, reason: skip }); continue; }
    const evidence = hint || inferredHint(binding, protocolRoles);
    let to;
    if (evidence) {
      to = evidence.name;
      let suffix = 2;
      while (!available(binding, to)) to = `${evidence.name}${suffix++}`;
    } else {
      const role = neutralRole(binding);
      let next = counters.get(role) || 1;
      do { to = `${role}${next++}`; } while (!available(binding, to));
      counters.set(role, next);
    }
    binding.scope.rename(from, to);
    for (let scope = binding.scope; scope; scope = scope.parent) if (forbiddenCache.has(scope)) forbiddenCache.get(scope).add(to);
    report.renamed.push({ from, to, line, kind: binding.kind, reason: evidence ? evidence.reason : 'neutral-lexical-label' });
    report.bindingsRenamed++;
    report[evidence ? 'evidenceBased' : 'neutral']++;
  }
  if (report.bindingsRenamed && context.warn) context.warn('READABLE_BINDINGS_RENAMED', `Assigned evidence-based or neutral labels to ${report.bindingsRenamed} lexical bindings.`, {
    bindingsRenamed: report.bindingsRenamed, evidenceBased: report.evidenceBased, neutral: report.neutral,
    webpackBundles: report.webpackBundles, webpackFactories: report.webpackFactories, assumptions: report.assumptions,
  });
  if (report.skipped.length && context.warn) context.warn('READABILITY_BINDINGS_PRESERVED', 'Some original binding names were retained for dynamic scope, public visibility, or observed names.', { count: report.skipped.length });
  return report.bindingsRenamed;
}

module.exports = { name: 'rename-bindings', description: 'Assign evidenced webpack/property names and stable neutral labels to private readable bindings.', STATE_KEY, run, renameBindings: run };
