'use strict';
const { t, traverse, analyzeDynamicScope, isPublic } = require('./_utils');
const { dominates } = require('./_dispatch');
const { analyzeWrapper, expandWrapper } = require('./_wrappers');
module.exports = {
  name: 'inline-wrappers',
  description: 'Expand parameter-only wrappers and call proxies with one-time ordered argument evaluation and lexical hygiene.',
  run(ast, context) {
    const dynamic = analyzeDynamicScope(ast, { context });
    // Replaced callee paths remain in Babel's binding reference snapshot until
    // the next crawl. Record this invariant before the first replacement so
    // subsequent calls are not rejected solely because those paths went stale.
    const callOnly = new Map();
    let count = 0;
    traverse(ast, { CallExpression: { exit(path) {
      if (!t.isIdentifier(path.node.callee) || path.node.optional) return;
      const binding = path.scope.getBinding(path.node.callee.name);
      if (!binding || !binding.constant || binding.constantViolations.length || isPublic(binding)) return;
      if (dynamic.affectsBinding(binding) || dynamic.affectsPath(path)) return;
      let fn;
      if (binding.path.isFunctionDeclaration()) {
        if (!binding.path.parentPath.isProgram() && !(binding.path.parentPath.isBlockStatement() && binding.path.parentPath.parentPath.isFunction() && binding.path.parentPath.key === 'body')) return;
        fn = binding.path;
      } else if (binding.path.isVariableDeclarator() && dominates(binding.path, path)) fn = binding.path.get('init');
      else return;
      if (!callOnly.has(binding)) callOnly.set(binding, binding.referencePaths.every(ref => ref.parentPath.isCallExpression() && ref.key === 'callee'));
      if (!callOnly.get(binding)) return;
      const replacement = expandWrapper(analyzeWrapper(fn), path);
      if (replacement) { path.replaceWith(replacement); count++; }
    } } });
    return count;
  },
};
