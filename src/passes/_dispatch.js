'use strict';

const { t, traverse, UNKNOWN, evaluate, isPublic, isWrite, propertyName } = require('./_utils');
const { analyzeWrapper, ignoresReceiver } = require('./_wrappers');

function containingFunction(path) { return path.getFunctionParent(); }

function earlier(point, use) {
  if (containingFunction(point) !== containingFunction(use)) return false;
  const statement = point.getStatementParent();
  if (!statement || !statement.inList) return false;
  let child = use;
  while (child && child.parentPath !== statement.parentPath) child = child.parentPath;
  if (child && child.inList && child.listKey === statement.listKey && child.key > statement.key) return true;
  // A later declarator or sequence item is eagerly evaluated after an earlier
  // item's initialization, even when normalization has not split the statement.
  let ancestor = point;
  while (ancestor && ancestor !== statement) {
    const parent = ancestor.parentPath;
    if (parent && (parent.isVariableDeclaration() || parent.isSequenceExpression())) {
      let useChild = use;
      while (useChild && useChild.parentPath !== parent) useChild = useChild.parentPath;
      if (useChild && ancestor.inList && useChild.inList && ancestor.listKey === useChild.listKey && useChild.key > ancestor.key) return true;
    }
    ancestor = parent;
  }
  return false;
}

function functionBinding(path) {
  if (path.isFunctionDeclaration() && path.node.id) return path.parentPath.scope.getBinding(path.node.id.name);
  if ((path.isFunctionExpression() || path.isArrowFunctionExpression()) && path.parentPath.isVariableDeclarator() && t.isIdentifier(path.parentPath.node.id)) return path.parentPath.scope.getBinding(path.parentPath.node.id.name);
  return null;
}

// Prove that the outermost closure containing a read cannot become callable
// before initialization. Textual placement alone is not enough for hoisted
// function declarations or callbacks registered before initialization.
function dominates(point, use, ownedFunctions = new Set(), active = new Set()) {
  if (earlier(point, use)) return true;
  const owner = containingFunction(point);
  let closure = containingFunction(use);
  if (!closure || closure === owner) return false;
  while (containingFunction(closure) && containingFunction(closure) !== owner) closure = containingFunction(closure);
  if (containingFunction(closure) !== owner) return false;
  if (ownedFunctions.has(closure.node)) return true;
  if (!closure.isFunctionDeclaration() && earlier(point, closure)) return true;
  if (active.has(closure.node)) return false;
  const binding = functionBinding(closure);
  if (!binding || !binding.constant || binding.constantViolations.length || isPublic(binding) || !binding.referencePaths.length) return false;
  active.add(closure.node);
  const safe = binding.referencePaths.every(reference => dominates(point, reference, ownedFunctions, active));
  active.delete(closure.node);
  return safe;
}

function prototypeHazard(ast) {
  let hazard = false;
  traverse(ast, { MemberExpression(path) {
    if (propertyName(path.node) !== 'prototype' || !t.isIdentifier(path.node.object, { name: 'Object' })) return;
    const parent = path.parentPath;
    if (!parent.isMemberExpression() || path.key !== 'object' || isWrite(parent) || ['__defineGetter__', '__defineSetter__'].includes(propertyName(parent.node))) { hazard = true; path.stop(); }
  } });
  return hazard;
}

function stageAssignments(root) {
  const statement = root.getStatementParent();
  if (!statement || !statement.inList) return [];
  const siblings = statement.parentPath.get(statement.listKey);
  const assignments = [];
  for (let i = statement.key + 1; i < siblings.length; i++) {
    const sibling = siblings[i];
    if (!sibling.isExpressionStatement()) break;
    const expression = sibling.get('expression');
    const items = expression.isSequenceExpression() ? expression.get('expressions') : [expression];
    if (!items.every(item => item.isAssignmentExpression({ operator: '=' }) && item.get('left').isMemberExpression() && t.isIdentifier(item.node.left.object, { name: root.node.id.name }) && item.get('left.object').scope.getBinding(root.node.id.name) === root.scope.getBinding(root.node.id.name) && propertyName(item.node.left) !== null)) break;
    assignments.push(...items);
  }
  return assignments;
}

function staticKey(property) {
  if (!property.node.computed && t.isIdentifier(property.node.key)) return property.node.key.name;
  if (t.isStringLiteral(property.node.key) || t.isNumericLiteral(property.node.key)) return String(property.node.key.value);
  return null;
}

function analyzeTable(root, options = {}) {
  if (!root.node || !t.isIdentifier(root.node.id) || !root.get('init').isObjectExpression()) return null;
  const binding = root.scope.getBinding(root.node.id.name);
  if (!binding || binding.path !== root || !binding.constant || binding.constantViolations.length || isPublic(binding)) return null;
  const stages = stageAssignments(root);
  if (stages.length && options.prototypeHazard) return null;
  const ready = stages.at(-1) || root;
  const properties = new Map(), ownedFunctions = new Set();
  function add(key, value, source) {
    if (key === null || key === '__proto__' || properties.has(key)) return false;
    const primitive = evaluate(value.node);
    const wrapper = primitive === UNKNOWN ? analyzeWrapper(value) : null;
    if (value.isFunctionExpression() || value.isArrowFunctionExpression()) ownedFunctions.add(value.node);
    properties.set(key, { key, value, source, primitive, wrapper, ignoresReceiver: ignoresReceiver(value.node) });
    return true;
  }
  for (const property of root.get('init.properties')) {
    if (!property.isObjectProperty() || property.node.method || !add(staticKey(property), property.get('value'), property)) return null;
  }
  for (const assignment of stages) if (!add(propertyName(assignment.node.left), assignment.get('right'), assignment)) return null;
  const stagesSet = new Set(stages.map(path => path.node));
  const aliases = new Map([[binding, root]]), pending = [binding], aliasReferences = new Set(), members = [];
  while (pending.length) {
    const current = pending.shift();
    for (const reference of current.referencePaths) {
      if (reference.parentPath.isVariableDeclarator() && reference.key === 'init' && t.isIdentifier(reference.parentPath.node.id)) {
        const alias = reference.parentPath;
        const next = alias.scope.getBinding(alias.node.id.name);
        if (!next || next.path !== alias || !next.constant || next.constantViolations.length || isPublic(next) || aliases.has(next) || !dominates(ready, alias, ownedFunctions) || !dominates(aliases.get(current), alias, current === binding ? ownedFunctions : new Set())) return null;
        aliases.set(next, alias);
        pending.push(next);
        aliasReferences.add(reference.node);
      } else {
        const member = reference.parentPath;
        if (!member.isMemberExpression() || member.node.optional || reference.key !== 'object') return null;
        if (member.parentPath.isAssignmentExpression() && member.key === 'left' && stagesSet.has(member.parentPath.node) && current === binding) continue;
        if (isWrite(member) || !dominates(ready, member, ownedFunctions) || !dominates(aliases.get(current), member, current === binding ? ownedFunctions : new Set())) return null;
        const key = propertyName(member.node);
        if (key === null || !properties.has(key)) return null;
        const entry = properties.get(key);
        const parent = member.parentPath;
        const receiverUsed = (parent.isCallExpression() || parent.isOptionalCallExpression()) && member.key === 'callee' || parent.isTaggedTemplateExpression() && member.key === 'tag';
        if (entry.primitive === UNKNOWN && receiverUsed && !entry.ignoresReceiver) return null;
        members.push({ path: member, entry });
      }
    }
  }
  return { root, binding, aliases, aliasReferences, properties, members, stages, ready };
}

function safeInitializer(node) { return evaluate(node) !== UNKNOWN || t.isFunctionExpression(node) || t.isArrowFunctionExpression(node); }

function removeDeclaration(path) {
  const declaration = path.parentPath;
  if (!declaration.isVariableDeclaration() || !declaration.inList) return false;
  if (declaration.node.declarations.length === 1) declaration.remove();
  else path.remove();
  return true;
}

function cleanupTable(table) {
  let count = 0;
  const program = table.root.findParent(path => path.isProgram());
  if (!program || !table.root.node || table.root.removed) return 0;
  program.scope.crawl();
  for (const [old, alias] of [...table.aliases].reverse()) {
    if (old === table.binding || !alias.node || alias.removed) continue;
    const binding = alias.scope.getBinding(alias.node.id.name);
    if (binding && !binding.referenced && !binding.constantViolations.length && removeDeclaration(alias)) count++;
  }
  program.scope.crawl();
  const root = table.root;
  if (!root.node || root.removed) return count;
  const binding = root.scope.getBinding(root.node.id.name);
  const stageNodes = new Set(table.stages.map(path => path.node));
  if (binding && !binding.constantViolations.length && binding.referencePaths.every(reference => reference.parentPath.isMemberExpression() && reference.key === 'object' && reference.parentPath.parentPath.isAssignmentExpression() && reference.parentPath.key === 'left' && stageNodes.has(reference.parentPath.parentPath.node)) && [...table.properties.values()].every(entry => safeInitializer(entry.value.node))) {
    // Staging accepted only whole expression statements whose every item is a
    // known initialization write. Remove each statement atomically: removing
    // individual sequence children would leave stale sibling NodePaths.
    const statements = [...new Set(table.stages.map(stage => stage.getStatementParent()))];
    for (const statement of statements.reverse()) if (statement.node && !statement.removed) statement.remove();
    if (removeDeclaration(root)) count++;
  }
  return count;
}

module.exports = { analyzeTable, dominates, earlier, prototypeHazard, cleanupTable };
