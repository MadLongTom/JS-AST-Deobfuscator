'use strict';
const { t, traverse, UNKNOWN, evaluate, analyzeDynamicScope, isPublic } = require('./_utils');

function declarations(node) {
  const vars = new Set();
  let lexical = false;
  function visit(value) {
    if (!value) return;
    if (t.isFunctionDeclaration(value) || t.isClassDeclaration(value)) { lexical = true; return; }
    if (t.isFunction(value) || t.isClass(value)) return;
    if (t.isVariableDeclaration(value)) {
      if (value.kind !== 'var') lexical = true;
      else for (const item of value.declarations) for (const name of Object.keys(t.getBindingIdentifiers(item.id))) vars.add(name);
    }
    for (const key of t.VISITOR_KEYS[value.type] || []) {
      if (Array.isArray(value[key])) value[key].forEach(visit);
      else visit(value[key]);
    }
  }
  visit(node);
  return { vars, lexical };
}

function hoisted(names) {
  return names.size ? t.variableDeclaration('var', [...names].map(name => t.variableDeclarator(t.identifier(name)))) : null;
}

function safeAllocation(node) {
  if (!node || evaluate(node) !== UNKNOWN || t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return true;
  if (t.isArrayExpression(node)) return node.elements.every(item => !item || !t.isSpreadElement(item) && safeAllocation(item));
  if (t.isObjectExpression(node)) return node.properties.every(item => t.isObjectProperty(item) && !item.computed && !item.method && safeAllocation(item.value));
  return false;
}

function preserveValue(path, replacement) {
  const parent = path.parentPath;
  // A conditional/logical expression produces a value, not a Reference. Keep
  // method receivers and direct-eval semantics unchanged when replacing it.
  if ((parent.isCallExpression() || parent.isOptionalCallExpression()) && path.key === 'callee' || parent.isTaggedTemplateExpression() && path.key === 'tag') {
    if (t.isMemberExpression(replacement) || t.isOptionalMemberExpression(replacement) || t.isIdentifier(replacement)) return t.sequenceExpression([t.numericLiteral(0), replacement]);
  }
  // typeof has special nonthrowing behavior for a bare unbound name; the
  // original conditional/logical expression had already performed GetValue.
  if (parent.isUnaryExpression({ operator: 'typeof' }) && t.isIdentifier(replacement)) return t.sequenceExpression([t.numericLiteral(0), replacement]);
  if (parent.isUnaryExpression({ operator: 'delete' })) return null;
  return replacement;
}

module.exports = {
  name: 'dead-code',
  description: 'Remove provably unreachable branches and unused private declarations while preserving hoisting and effects.',
  run(ast, context) {
    const dynamic = analyzeDynamicScope(ast, { context });
    let count = 0;
    traverse(ast, {
      WhileStatement: { exit(path) {
        const test = evaluate(path.node.test);
        if (test === UNKNOWN || test) return;
        const lost = declarations(path.node.body);
        let blockFunction = false;
        t.traverseFast(path.node.body, node => { if (t.isFunctionDeclaration(node)) blockFunction = true; });
        if (blockFunction) return;
        const vars = hoisted(lost.vars);
        path.replaceWith(t.blockStatement(vars ? [vars] : []));
        count++;
      } },
      IfStatement: { exit(path) {
        const test = evaluate(path.node.test);
        if (test === UNKNOWN) return;
        const discarded = test ? path.node.alternate : path.node.consequent;
        const selected = test ? path.node.consequent : path.node.alternate;
        const lost = declarations(discarded);
        // Block functions can have Annex B bindings; retain these constructs.
        if (lost.lexical && (() => { let found = false; if (discarded) t.traverseFast(discarded, node => { if (t.isFunctionDeclaration(node)) found = true; }); return found; })()) return;
        if (selected && t.isFunctionDeclaration(selected)) return;
        const body = [];
        const vars = hoisted(lost.vars);
        if (vars) body.push(vars);
        if (selected) body.push(t.cloneNode(selected, true));
        path.replaceWith(t.blockStatement(body));
        count++;
      } },
      ConditionalExpression: { exit(path) {
        const test = evaluate(path.node.test);
        if (test === UNKNOWN) return;
        const replacement = preserveValue(path, t.cloneNode(test ? path.node.consequent : path.node.alternate, true));
        if (replacement) { path.replaceWith(replacement); count++; }
      } },
      LogicalExpression: { exit(path) {
        const left = evaluate(path.node.left);
        if (left === UNKNOWN) return;
        const useRight = path.node.operator === '&&' ? !!left : path.node.operator === '||' ? !left : left == null;
        const replacement = preserveValue(path, t.cloneNode(useRight ? path.node.right : path.node.left, true));
        if (replacement) { path.replaceWith(replacement); count++; }
      } },
      'BlockStatement|Program': { exit(path) {
        const statements = path.get('body');
        let unreachable = false;
        for (const statement of statements) {
          if (unreachable) {
            if (!statement.node) continue;
            const retained = declarations(statement.node);
            if (retained.lexical) continue;
            const vars = hoisted(retained.vars);
            if (vars) {
              if (!t.isNodesEquivalent(statement.node, vars)) { statement.replaceWith(vars); count++; }
            } else { statement.remove(); count++; }
          } else if (statement.isReturnStatement() || statement.isThrowStatement() || statement.isBreakStatement() || statement.isContinueStatement()) unreachable = true;
        }
      } },
    });
    // Branch rewrites changed references; refresh bindings before deleting any.
    traverse(ast, { Program(path) { path.scope.crawl(); } });
    traverse(ast, {
      VariableDeclarator(path) {
        if (!t.isIdentifier(path.node.id) || !safeAllocation(path.node.init)) return;
        const binding = path.scope.getBinding(path.node.id.name);
        if (!binding || binding.path !== path || binding.referenced || binding.constantViolations.length || isPublic(binding)) return;
        if (dynamic.affectsBinding(binding)) return;
        // Keep headers and declarations which are also assignment targets.
        if (!path.parentPath.parentPath || !path.parentPath.inList) return;
        const declaration = path.parentPath;
        if (declaration.node.declarations.length === 1) declaration.remove();
        else path.remove();
        count++;
      },
      FunctionDeclaration(path) {
        if (!path.node.id || !path.inList) return;
        // Sloppy block functions may create an additional Annex B binding in
        // the enclosing var scope which Babel's block binding does not track.
        if (!path.parentPath.isProgram() && !(path.parentPath.isBlockStatement() && path.parentPath.parentPath.isFunction() && path.parentPath.key === 'body')) return;
        const binding = path.parentPath.scope.getBinding(path.node.id.name);
        if (!binding || binding.path !== path || binding.referenced || binding.constantViolations.length || isPublic(binding)) return;
        if (dynamic.affectsBinding(binding)) return;
        path.remove();
        count++;
      },
    });
    return count;
  },
};
