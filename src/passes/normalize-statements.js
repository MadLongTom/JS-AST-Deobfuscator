'use strict';

const { t, traverse } = require('./_utils');

function expressionStatement(expression) {
  // A newly exposed string must not become a function/program directive.
  return t.expressionStatement(t.isStringLiteral(expression) ? t.parenthesizedExpression(expression) : expression);
}

function expressionStatements(expression) {
  if (t.isSequenceExpression(expression)) return expression.expressions.flatMap(expressionStatements);
  if (t.isConditionalExpression(expression)) return [t.ifStatement(
    expression.test,
    t.blockStatement(expressionStatements(expression.consequent)),
    t.blockStatement(expressionStatements(expression.alternate)),
  )];
  if (t.isLogicalExpression(expression) && ['&&', '||'].includes(expression.operator)) return [t.ifStatement(
    expression.operator === '&&' ? expression.left : t.unaryExpression('!', expression.left, true),
    t.blockStatement(expressionStatements(expression.right)),
  )];
  return [expressionStatement(expression)];
}

module.exports = {
  name: 'normalize-statements',
  description: 'Expose ordered statement sequences, staged declarations and statement-only conditionals without moving effects.',
  run(ast) {
    let changes = 0;
    traverse(ast, {
      VariableDeclaration(path) {
        if (!['var', 'let', 'const'].includes(path.node.kind) || !path.inList) return;
        if (!path.parentPath.isProgram() && !path.parentPath.isBlockStatement() && !path.parentPath.isSwitchCase()) return;
        if (path.node.declarations.length === 1) {
          const declaration = path.node.declarations[0];
          if (!t.isSequenceExpression(declaration.init)) return;
          const expressions = declaration.init.expressions;
          const prefix = expressions.slice(0, -1).flatMap(expressionStatements);
          const clone = t.cloneNode(path.node, false);
          const declarator = t.cloneNode(declaration, false);
          declarator.init = expressions[expressions.length - 1];
          clone.declarations = [declarator];
          t.inheritsComments(prefix[0], path.node);
          clone.leadingComments = undefined;
          path.replaceWithMultiple([...prefix, clone]);
          changes++;
          return;
        }
        const declarations = path.node.declarations.map((declaration, index, all) => {
          const node = t.cloneNode(path.node, false);
          node.declarations = [declaration];
          if (index !== 0) node.leadingComments = undefined;
          if (index !== all.length - 1) node.trailingComments = undefined;
          return node;
        });
        path.replaceWithMultiple(declarations);
        changes++;
      },
      ExpressionStatement: { exit(path) {
        const expression = path.node.expression;
        if (!t.isSequenceExpression(expression) && !t.isConditionalExpression(expression) && !(t.isLogicalExpression(expression) && ['&&', '||'].includes(expression.operator))) return;
        const statements = expressionStatements(expression);
        t.inheritsComments(statements[0], path.node);
        if (path.inList) path.replaceWithMultiple(statements);
        else path.replaceWith(t.blockStatement(statements));
        changes++;
      } },
      ReturnStatement: { exit(path) {
        if (!t.isSequenceExpression(path.node.argument)) return;
        const expressions = path.node.argument.expressions;
        const statements = expressions.slice(0, -1).flatMap(expressionStatements);
        statements.push(t.returnStatement(expressions[expressions.length - 1]));
        t.inheritsComments(statements[0], path.node);
        if (path.inList) path.replaceWithMultiple(statements);
        else path.replaceWith(t.blockStatement(statements));
        changes++;
      } },
      BlockStatement: { exit(path) {
        if (!path.inList || !(path.parentPath.isBlockStatement() || path.parentPath.isProgram()) || path.node.directives.length) return;
        let scoped = false;
        t.traverseFast(path.node, node => {
          if (t.isVariableDeclaration(node) && node.kind !== 'var' || t.isFunctionDeclaration(node) || t.isClassDeclaration(node)) scoped = true;
        });
        if (scoped) return;
        path.replaceWithMultiple(path.node.body.map(statement =>
          t.isExpressionStatement(statement) && t.isStringLiteral(statement.expression) ? expressionStatement(statement.expression) : statement));
        changes++;
      } },
    });
    return changes;
  },
};
