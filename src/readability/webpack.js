'use strict';

const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;

function memberName(node) {
  if (!t.isMemberExpression(node)) return null;
  return node.computed ? t.isStringLiteral(node.property) ? node.property.value : null : node.property.name;
}

function functionBinding(path) {
  if (path.isFunctionDeclaration() && path.node.id) return path.parentPath.scope.getBinding(path.node.id.name);
  if (path.parentPath.isVariableDeclarator() && t.isIdentifier(path.parentPath.node.id)) return path.parentPath.scope.getBinding(path.parentPath.node.id.name);
  return null;
}

function tableEntries(path) {
  if (path.isArrayExpression()) return path.get('elements').flatMap((entry, index) => entry.node && entry.isFunction() ? [{ id: index, path: entry }] : []);
  if (path.isObjectExpression()) {
    const entries = new Map();
    for (const property of path.get('properties')) {
      // A spread or an unknown computed key can replace any earlier entry.
      if (!property.isObjectProperty() || property.node.computed && !t.isStringLiteral(property.node.key) && !t.isNumericLiteral(property.node.key)) return [];
      const key = property.node.key;
      if (!t.isIdentifier(key) && !t.isStringLiteral(key) && !t.isNumericLiteral(key)) return [];
      const id = t.isIdentifier(key) ? key.name : key.value;
      if (String(id) === '__proto__' && !property.node.computed && !property.node.shorthand) return [];
      // Object property lookup sees the final definition, including a later
      // non-function value that replaces an earlier factory.
      entries.delete(String(id));
      if (property.get('value').isFunction()) entries.set(String(id), { id, path: property.get('value') });
    }
    return [...entries.values()];
  }
  return [];
}

function moduleRecord(path) {
  if (!path.isVariableDeclarator()) return false;
  let init = path.get('init');
  while (init.isAssignmentExpression({ operator: '=' })) init = init.get('right');
  return init.isObjectExpression() && init.node.properties.some(property => t.isObjectProperty(property) && !property.computed
    && (t.isIdentifier(property.key, { name: 'exports' }) || t.isStringLiteral(property.key, { value: 'exports' })));
}

function cacheBindingsFor(protocol, bootstrap) {
  const cacheBindings = new Set();
  const { moduleBinding, moduleIdBinding } = protocol;
  function assigned(member) {
    if (!member.isMemberExpression() || !member.node.computed || !member.get('object').isIdentifier() || !member.get('property').isIdentifier()) return;
    if (member.scope.getBinding(member.node.property.name) !== moduleIdBinding) return;
    const binding = member.scope.getBinding(member.node.object.name);
    if (binding && binding.constant && binding.scope === bootstrap.scope && binding.path.isVariableDeclarator()
      && binding.path.get('init').isObjectExpression() && binding.path.node.init.properties.length === 0) cacheBindings.add(binding);
  }
  let init = moduleBinding.path.get('init');
  while (init.isAssignmentExpression({ operator: '=' })) {
    assigned(init.get('left'));
    init = init.get('right');
  }
  for (const reference of moduleBinding.referencePaths) {
    if (reference.key === 'right' && reference.parentPath.isAssignmentExpression({ operator: '=' })) assigned(reference.parentPath.get('left'));
  }
  return [...cacheBindings];
}

// Recognition requires the actual module invocation protocol, not just an array
// of three-argument functions. No bootstrap or factory is ever executed.
function findWebpackBundles(ast) {
  const bundles = [];
  traverse(ast, {
    CallExpression(call) {
      const bootstrap = call.get('callee');
      if (!bootstrap.isFunctionExpression() && !bootstrap.isArrowFunctionExpression()) return;
      for (let parameterIndex = 0; parameterIndex < bootstrap.node.params.length; parameterIndex++) {
        const parameter = bootstrap.node.params[parameterIndex];
        const table = call.get(`arguments.${parameterIndex}`);
        if (!t.isIdentifier(parameter) || !table || !table.node) continue;
        const factories = tableEntries(table);
        if (!factories.length) continue;
        const tableBinding = bootstrap.scope.getBinding(parameter.name);
        if (!tableBinding || !tableBinding.constant) continue;
        let protocol = null;
        for (const reference of tableBinding.referencePaths) {
          const lookup = reference.parentPath;
          if (!lookup.isMemberExpression() || reference.key !== 'object' || !lookup.node.computed) continue;
          let invocation = lookup.parentPath;
          let offset = 0;
          if (invocation.isMemberExpression() && lookup.key === 'object' && memberName(invocation.node) === 'call') {
            invocation = invocation.parentPath;
            offset = 1;
          }
          if (!invocation.isCallExpression() || invocation.get('callee').node !== (offset ? lookup.parentPath.node : lookup.node)) continue;
          const args = invocation.get('arguments');
          if (args.length !== offset + 3 || !args[offset].isIdentifier() || !args[offset + 1].isMemberExpression() || !args[offset + 2].isIdentifier()) continue;
          const moduleBinding = args[offset].scope.getBinding(args[offset].node.name);
          const exportsObject = args[offset + 1].get('object');
          if (!moduleBinding || !exportsObject.isIdentifier() || exportsObject.scope.getBinding(exportsObject.node.name) !== moduleBinding) continue;
          const loader = invocation.getFunctionParent();
          const loaderBinding = loader && functionBinding(loader);
          if (!loaderBinding || !loaderBinding.constant || loaderBinding.scope !== bootstrap.scope
            || args[offset + 2].scope.getBinding(args[offset + 2].node.name) !== loaderBinding) continue;
          const firstParameter = loader.node.params[0];
          const moduleIdBinding = t.isIdentifier(firstParameter) && loader.scope.getBinding(firstParameter.name);
          const index = lookup.get('property');
          if (!moduleIdBinding || !index.isIdentifier() || index.scope.getBinding(index.node.name) !== moduleIdBinding) continue;
          if (moduleBinding.scope !== loader.scope || !moduleBinding.constant || !moduleRecord(moduleBinding.path)
            || memberName(args[offset + 1].node) !== 'exports') continue;
          protocol = { loader, loaderBinding, moduleBinding, moduleIdBinding, tableBinding, invocation };
          break;
        }
        if (!protocol) continue;
        const cacheBindings = cacheBindingsFor(protocol, bootstrap);
        const entryIds = [];
        for (const reference of protocol.loaderBinding.referencePaths) {
          const invocation = reference.parentPath;
          if (!invocation.isCallExpression() || reference.key !== 'callee' || invocation.getFunctionParent() !== bootstrap || invocation.node.arguments.length !== 1) continue;
          const argument = invocation.node.arguments[0];
          if (t.isStringLiteral(argument) || t.isNumericLiteral(argument)) entryIds.push(argument.value);
        }
        bundles.push({ index: bundles.length, bootstrap, table, factories, ...protocol, cacheBindings, entryIds: [...new Set(entryIds)] });
      }
    },
  });
  return bundles;
}

/** Return serializable, syntax-derived module IDs, locations and literal calls. */
function indexWebpackModules(ast) {
  return findWebpackBundles(ast).map(bundle => ({
    bundle: bundle.index,
    line: bundle.table.node.loc && bundle.table.node.loc.start.line,
    endLine: bundle.table.node.loc && bundle.table.node.loc.end.line,
    entryIds: bundle.entryIds,
    modules: bundle.factories.map(factory => {
      const dependencies = [];
      const requireParameter = factory.path.node.params[2];
      const requireBinding = t.isIdentifier(requireParameter) && factory.path.scope.getBinding(requireParameter.name);
      if (requireBinding && requireBinding.constant) for (const reference of requireBinding.referencePaths) {
        const call = reference.parentPath;
        if (!call.isCallExpression() || reference.key !== 'callee' || call.node.arguments.length !== 1) continue;
        const argument = call.node.arguments[0];
        if (t.isStringLiteral(argument) || t.isNumericLiteral(argument)) dependencies.push(argument.value);
      }
      return {
        id: factory.id,
        line: factory.path.node.loc && factory.path.node.loc.start.line,
        endLine: factory.path.node.loc && factory.path.node.loc.end.line,
        parameters: factory.path.node.params.map(parameter => t.isIdentifier(parameter) ? parameter.name : '(pattern)'),
        dependencies: [...new Set(dependencies)],
      };
    }),
  }));
}

/** Extract each factory as an independently printable expression; never run it. */
function webpackModuleExcerpts(ast) {
  return findWebpackBundles(ast).flatMap(bundle => bundle.factories.map(factory => ({
    bundle: bundle.index, id: factory.id,
    line: factory.path.node.loc && factory.path.node.loc.start.line,
    endLine: factory.path.node.loc && factory.path.node.loc.end.line,
    code: generate(t.expressionStatement(t.cloneNode(factory.path.node, true)), { comments: true }).code,
  })));
}

module.exports = { findWebpackBundles, indexWebpackModules, webpackModuleExcerpts };
