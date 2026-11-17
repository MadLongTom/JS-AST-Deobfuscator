'use strict';
const { t, traverse, UNKNOWN, evaluate, literal } = require('./_utils');
module.exports = {
  name: 'constant-fold',
  description: 'Fold statically known primitive operations; never execute calls or access properties.',
  run(ast) {
    let count = 0;
    traverse(ast, { 'UnaryExpression|BinaryExpression|LogicalExpression|ConditionalExpression|TemplateLiteral': { exit(path) {
      if (path.parentPath.isTaggedTemplateExpression() && path.key === 'quasi') return;
      const value = evaluate(path.node);
      if (value === UNKNOWN) return;
      const replacement = literal(value);
      if (t.isNodesEquivalent(path.node, replacement)) return;
      path.replaceWith(replacement);
      count++;
    } } });
    return count;
  },
};
