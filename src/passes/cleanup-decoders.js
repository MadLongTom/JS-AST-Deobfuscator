'use strict';
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { analyzeDynamicScope } = require('./_utils');
const { within, bindingForFunction, memberName, removeDeclaration, removeExpression } = require('../decoders/scaffolds');

function exported(path) {
  let declaration = path;
  if (path.isVariableDeclarator()) declaration = path.parentPath;
  else if (path.parentPath.isVariableDeclarator()) declaration = path.parentPath.parentPath;
  return declaration.parentPath && (declaration.parentPath.isExportNamedDeclaration() || declaration.parentPath.isExportDefaultDeclaration());
}

function run(ast, context) {
  const metadata = context.state && context.state.get('string-arrays:families');
  if (!metadata || metadata.ast !== ast || !metadata.families.length) return 0;
  const dynamic = analyzeDynamicScope(ast, { context });
  const readable = context.options.profile === 'readable';
  let changes = 0;
  for (const family of metadata.families) {
    const nodes = new Set([family.providerNode, ...family.decoderNodes, ...family.rotationNodes]);
    const paths = new Map();
    traverse(ast, { enter(path) { if (nodes.has(path.node)) paths.set(path.node, path); } });
    const provider = paths.get(family.providerNode);
    const decoders = family.decoderNodes.map(node => paths.get(node)).filter(Boolean);
    if (!provider || !decoders.length) continue;
    const rootPaths = [provider, ...decoders], roots = new Set(rootPaths.map(bindingForFunction).filter(Boolean));
    if ([...roots].some(binding => dynamic.affectsBinding(binding))) continue;
    const rotationPaths = family.rotationNodes.map(node => paths.get(node)).filter(Boolean);
    const aliases = new Map();
    const rootOf = (binding, seen = new Set()) => {
      if (roots.has(binding)) return binding;
      if (!binding || !binding.constant || seen.has(binding) || !binding.path.isVariableDeclarator() || !binding.path.get('init').isIdentifier()) return null;
      seen.add(binding);
      return rootOf(binding.path.get('init').scope.getBinding(binding.path.node.init.name), seen);
    };
    traverse(ast, { VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id) || !path.get('init').isIdentifier()) return;
      const binding = path.scope.getBinding(path.node.id.name);
      if (rootOf(binding) && !dynamic.affectsBinding(binding)) aliases.set(binding, path);
    } });
    // Remove leaves first; a fresh scope crawl in the next pass iteration then
    // exposes preceding alias links. Top-level script bindings stay public in safe.
    let privateGlobalAliases = 0;
    for (const [binding, alias] of aliases) {
      if (binding.referenced || binding.constantViolations.length || exported(alias)) continue;
      if (!readable && binding.scope.path.isProgram()) continue;
      const source = alias.get('init').scope.getBinding(alias.node.init.name);
      if (!source || (!source.path.isFunctionDeclaration() && source.path.node.start >= alias.node.start)) continue;
      if (removeDeclaration(alias)) { changes++; if (binding.scope.path.isProgram()) privateGlobalAliases++; }
    }
    if (privateGlobalAliases) context.warn('READABLE_PRIVATE_ALIAS_REMOVED', 'Removed unused top-level aliases of recognized decoder helpers under the readable profile.', {
      count: privateGlobalAliases, assumption: 'Unexported top-level obfuscator aliases are private to this input; external scripts do not read them.'
    });
    if (!readable || !family.usable || rootPaths.some(exported)) continue;
    // Bindings are rebuilt after alias deletion, never reused across mutations.
    traverse(ast, { Program(path) { path.scope.crawl(); path.stop(); } });
    const liveRoots = new Set(rootPaths.map(bindingForFunction).filter(Boolean));
    const liveAliases = new Map();
    const liveRootOf = (binding, seen = new Set()) => {
      if (liveRoots.has(binding)) return binding;
      if (!binding || !binding.constant || seen.has(binding) || !binding.path.isVariableDeclarator() || !binding.path.get('init').isIdentifier()) return null;
      seen.add(binding);
      return liveRootOf(binding.path.get('init').scope.getBinding(binding.path.node.init.name), seen);
    };
    traverse(ast, { VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return;
      const binding = path.scope.getBinding(path.node.id.name);
      if (liveRootOf(binding) && !liveRoots.has(binding) && !dynamic.affectsBinding(binding)) liveAliases.set(binding, path);
    } });
    let blocked = false;
    const internal = reference => rootPaths.some(path => within(reference, path)) || rotationPaths.some(path => within(reference, path));
    for (const binding of [...liveRoots, ...liveAliases.keys()]) {
      if (exported(binding.path)) { blocked = true; break; }
      if (binding.constantViolations.some(write => !internal(write))) { blocked = true; break; }
      for (const reference of binding.referencePaths) {
        if (internal(reference)) continue;
        const parent = reference.parentPath;
        if (parent.isVariableDeclarator() && parent.get('init') === reference && liveAliases.has(parent.scope.getBinding(parent.node.id.name))) continue;
        blocked = true; break;
      }
      if (blocked) break;
    }
    if (blocked) continue;
    // A solved checksum alone is insufficient: the IIFE must have no unknown
    // calls, global reads/writes, exports, or other startup effects.
    for (const rotation of rotationPaths) {
      const fn = rotation.get('callee');
      if (!fn.isFunction()) { blocked = true; break; }
      const tableBindings = new Set();
      fn.traverse({ VariableDeclarator(path) {
        const init = path.get('init');
        if (!t.isIdentifier(path.node.id) || !init.isCallExpression() || !init.get('callee').isIdentifier()) return;
        const source = init.scope.getBinding(init.node.callee.name);
        if (source && source.kind === 'param' && source.scope === fn.scope) tableBindings.add(path.scope.getBinding(path.node.id.name));
      } });
      fn.traverse({
        ReferencedIdentifier(path) {
          const binding = path.scope.getBinding(path.node.name);
          if (!binding && !['parseInt', 'Number', 'String', 'undefined'].includes(path.node.name)) blocked = true;
          if (binding && !within(binding.path, fn) && !liveRootOf(binding)) blocked = true;
        },
        CallExpression(path) {
          const callee = path.get('callee');
          if (callee.isIdentifier()) {
            const binding = callee.scope.getBinding(callee.node.name);
            if (!binding && ['parseInt', 'Number', 'String'].includes(callee.node.name)) return;
            if (liveRootOf(binding) || binding && binding.kind === 'param' && binding.scope === fn.scope) return;
          } else if (callee.isMemberExpression() && ['push', 'shift'].includes(memberName(callee.node)) && t.isIdentifier(callee.node.object) && tableBindings.has(callee.scope.getBinding(callee.node.object.name))) return;
          blocked = true;
        },
        AssignmentExpression(path) {
          const left = path.get('left');
          const binding = left.isIdentifier() && left.scope.getBinding(left.node.name);
          if (!binding || !within(binding.path, fn)) blocked = true;
        },
        UpdateExpression(path) {
          const argument = path.get('argument');
          const binding = argument.isIdentifier() && argument.scope.getBinding(argument.node.name);
          if (!binding || !within(binding.path, fn)) blocked = true;
        },
        NewExpression() { blocked = true; },
        ThrowStatement() { blocked = true; },
        ReturnStatement() { blocked = true; }
      });
    }
    if (blocked) {
      context.warn('DECODER_CLEANUP_PRESERVED_EFFECTS', 'Recognized decoder family was preserved because its startup rotation has additional effects.', { provider: family.providerName });
      continue;
    }
    if (rotationPaths.some(path => !(path.parentPath.isExpressionStatement() || path.parentPath.isSequenceExpression() && path.parentPath.parentPath.isExpressionStatement() || path.parentPath.isUnaryExpression() && path.parentPath.parentPath.isExpressionStatement()))) continue;
    const decoderNames = decoders.map(path => path.node && path.node.id && path.node.id.name).filter(Boolean);
    let embeddedSourceChecks = 0;
    for (const decoder of decoders) decoder.traverse({ CallExpression(path) {
      if (path.node.arguments.length || !path.get('callee').isMemberExpression() || memberName(path.node.callee) !== 'toString') return;
      const object = path.get('callee.object');
      if (object.isMemberExpression() && object.get('object').isThisExpression() && path.parentPath.isCallExpression() && memberName(path.parentPath.node.callee) === 'test') embeddedSourceChecks++;
    } });
    let removed = 0;
    for (const alias of liveAliases.values()) if (removeDeclaration(alias)) { changes++; removed++; }
    for (const rotation of rotationPaths) if (removeExpression(rotation)) { changes++; removed++; }
    for (const root of rootPaths) if (removeDeclaration(root)) { changes++; removed++; }
    if (removed) context.warn('READABLE_DECODER_SCAFFOLD_REMOVED', 'Removed an unused recognized decoder/provider/rotation family under the readable profile.', {
      provider: family.providerName, decoders: decoderNames, removedDeclarationsOrCalls: removed, removedEmbeddedSourceChecks: embeddedSourceChecks,
      assumption: 'Unexported top-level obfuscator helpers are private to this input; external scripts do not call them.'
    });
  }
  return changes;
}

module.exports = { name: 'cleanup-decoders', description: 'Remove unused private decoder aliases; readable profile also removes verified unused decoder families.', run };
