'use strict';

const { t, traverse, analyzeDynamicScope, isPublic } = require('./_utils');
const { dominates } = require('./_dispatch');

module.exports = {
  name: 'inline-aliases',
  description: 'Resolve private immutable identifier aliases after initialization without capturing names or changing indirect eval.',
  run(ast, context) {
    const dynamic = analyzeDynamicScope(ast, { context });
    let changes = 0;
    traverse(ast, { VariableDeclarator(path) {
      if (!path.get('id').isIdentifier() || !path.get('init').isIdentifier()) return;
      const alias = path.scope.getBinding(path.node.id.name);
      const source = path.get('init').scope.getBinding(path.node.init.name);
      if (!alias || !source || alias === source || !alias.constant || !source.constant ||
          alias.constantViolations.length || source.constantViolations.length || isPublic(alias) || isPublic(source) || source.kind === 'module' ||
          ['eval', 'arguments'].includes(alias.identifier.name) || ['eval', 'arguments'].includes(source.identifier.name)) return;
      if (dynamic.affectsBinding(alias) || dynamic.affectsBinding(source) || dynamic.affectsPath(path)) return;
      if (source.kind !== 'param' && !source.path.isFunctionDeclaration() && !dominates(source.path, path)) return;
      for (const reference of alias.referencePaths.slice()) {
        if (!reference.node || reference.removed || !reference.isReferencedIdentifier() ||
            !dominates(path, reference) || dynamic.affectsPath(reference) ||
            reference.scope.getBinding(source.identifier.name) !== source) continue;
        reference.replaceWith(t.identifier(source.identifier.name));
        changes++;
      }
    } });
    traverse(ast, { Program(path) { path.scope.crawl(); path.stop(); } });
    traverse(ast, { VariableDeclarator(path) {
      if (!path.get('id').isIdentifier() || !path.get('init').isIdentifier() || !path.parentPath.inList) return;
      const alias = path.scope.getBinding(path.node.id.name);
      const source = path.get('init').scope.getBinding(path.node.init.name);
      if (!alias || !source || alias === source || alias.referenced || !alias.constant || !source.constant ||
          alias.constantViolations.length || source.constantViolations.length || isPublic(alias) || isPublic(source) || source.kind === 'module' ||
          ['eval', 'arguments'].includes(alias.identifier.name) || ['eval', 'arguments'].includes(source.identifier.name) ||
          dynamic.affectsBinding(alias) || dynamic.affectsBinding(source) || dynamic.affectsPath(path)) return;
      if (source.kind !== 'param' && !source.path.isFunctionDeclaration() && !dominates(source.path, path)) return;
      if (path.parentPath.node.declarations.length === 1) path.parentPath.remove();
      else path.remove();
      changes++;
    } });
    return changes;
  },
};
