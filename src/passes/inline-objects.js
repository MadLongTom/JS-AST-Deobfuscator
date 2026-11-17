'use strict';
const { traverse, UNKNOWN, literal, analyzeDynamicScope } = require('./_utils');
const { analyzeTable, prototypeHazard, cleanupTable } = require('./_dispatch');
const { expandWrapper } = require('./_wrappers');
module.exports = {
  name: 'inline-objects',
  description: 'Resolve immutable private dispatch tables, aliases and staged initialization across proven-safe closures.',
  run(ast, context) {
    const dynamic = analyzeDynamicScope(ast, { context });
    const hazard = prototypeHazard(ast);
    const tables = [];
    let count = 0;
    traverse(ast, { VariableDeclarator(path) {
      const table = analyzeTable(path, { prototypeHazard: hazard });
      if (table && ![...table.aliases.keys()].some(binding => dynamic.affectsBinding(binding)) &&
          !table.members.some(use => dynamic.affectsPath(use.path))) tables.push(table);
    } });
    for (const table of tables.reverse()) {
      for (const use of table.members.reverse()) {
        const member = use.path;
        if (!member.node || member.removed || !member.isMemberExpression()) continue;
        const entry = use.entry;
        if (entry.wrapper && member.parentPath.isCallExpression() && member.key === 'callee') {
          const call = member.parentPath;
          const replacement = expandWrapper(entry.wrapper, call);
          if (replacement) { call.replaceWith(replacement); count++; }
        } else if (entry.primitive !== UNKNOWN) {
          member.replaceWith(literal(entry.primitive));
          count++;
        }
      }
    }
    for (const table of tables) count += cleanupTable(table);
    return count;
  },
};
