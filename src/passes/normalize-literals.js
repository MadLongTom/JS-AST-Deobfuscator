'use strict';
const { t, traverse } = require('./_utils');
module.exports = {
  name: 'normalize-literals',
  description: 'Normalize escaped strings, numeric spellings, and static identifier-shaped property access.',
  run(ast) {
    let count = 0;
    traverse(ast, { 'StringLiteral|NumericLiteral|BigIntLiteral'(path) {
      if (path.node.extra && (Object.prototype.hasOwnProperty.call(path.node.extra, 'raw') || Object.prototype.hasOwnProperty.call(path.node.extra, 'rawValue'))) {
        delete path.node.extra.raw;
        delete path.node.extra.rawValue;
        if (!Object.keys(path.node.extra).length) delete path.node.extra;
        count++;
      }
    }, 'MemberExpression|OptionalMemberExpression': { exit(path) {
      if (path.node.computed && t.isStringLiteral(path.node.property) && t.isValidIdentifier(path.node.property.value, false)) {
        path.node.property = t.identifier(path.node.property.value);
        path.node.computed = false;
        count++;
      }
    } } });
    return count;
  },
};
