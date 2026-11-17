'use strict';
const { t, traverse, UNKNOWN, evaluate, literal, analyzeDynamicScope, isPublic, initializedBefore } = require('./_utils');
module.exports = {
  name: 'inline-constants',
  description: 'Inline immutable private primitive bindings only after a dominating initialization.',
  run(ast, context) {
    const dynamic = analyzeDynamicScope(ast, { context });
    let count = 0;
    traverse(ast, { VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id) || !path.node.init) return;
      const binding = path.scope.getBinding(path.node.id.name);
      if (!binding || binding.path !== path || !binding.constant || binding.constantViolations.length || isPublic(binding)) return;
      if (dynamic.affectsBinding(binding)) return;
      const value = evaluate(path.node.init);
      if (value === UNKNOWN) return;
      for (const reference of binding.referencePaths.slice()) {
        if (reference.removed || !reference.isIdentifier() || !initializedBefore(path, reference)) continue;
        if (dynamic.affectsPath(reference)) continue;
        if (reference.parentPath.isUnaryExpression({ operator: 'delete' })) continue;
        reference.replaceWith(literal(value));
        count++;
      }
    } });
    return count;
  },
};
