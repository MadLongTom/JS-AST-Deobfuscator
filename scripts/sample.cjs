'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { deobfuscate } = require('../src');
const root = path.resolve(__dirname, '..');
const filename = path.join(root, 'test/fixtures/zhihuishu-2.obfuscated.js');
const source = fs.readFileSync(filename, 'utf8');
const baseline = require('../test/fixtures/zhihuishu-2.baseline.json');
const classBaseline = require('../test/fixtures/zhihuishu-2.classes-baseline.json');
const result = deobfuscate(source, { filename: path.basename(filename), sourceMaps: true, profile: 'readable' });
const directory = path.join(root, 'artifacts');
fs.mkdirSync(directory, { recursive: true });

function writeArtifact(stem, artifactResult = result) {
  const content = artifactResult.code + `\n//# sourceMappingURL=${stem}.js.map\n`;
  const report = { ...artifactResult.report, output: { bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') } };
  fs.writeFileSync(path.join(directory, `${stem}.js`), content);
  fs.writeFileSync(path.join(directory, `${stem}.js.map`), JSON.stringify({ ...artifactResult.map, file: `${stem}.js` }));
  fs.writeFileSync(path.join(directory, `${stem}.report.json`), JSON.stringify(report, null, 2) + '\n');
  return report;
}

const report = writeArtifact('zhihuishu-2.readable');
writeArtifact('zhihuishu-2');

function libraryTag(statement) {
  if (!t.isExpressionStatement(statement)) return null;
  let expression = statement.expression;
  while (t.isUnaryExpression(expression)) expression = expression.argument;
  if (!t.isCallExpression(expression) || !t.isFunction(expression.callee)) return null;
  const identifiers = new Set();
  t.traverseFast(statement, node => { if (t.isIdentifier(node)) identifiers.add(node.name); });
  if (!identifiers.has('exports') || !identifiers.has('define') || !identifiers.has('module')) return null;
  if (identifiers.has('JSEncrypt')) return 'JSEncrypt';
  if (identifiers.has('CryptoJS')) return 'CryptoJS';
  return null;
}

// Labelled analysis excerpts, not independently runnable bundles.
const ast = parser.parse(result.code);
const business = [], libraries = [], sections = [];
for (const statement of ast.program.body) {
  const tag = libraryTag(statement);
  if (tag) { libraries.push(statement); sections.push({ library: tag, line: statement.loc.start.line, endLine: statement.loc.end.line }); }
  else business.push(statement);
}
for (const [name, body, note] of [
  ['business', business, 'Business analysis excerpt. Requires CryptoJS, JSEncrypt and page globals; not a standalone bundle.'],
  ['libraries', libraries, 'Library analysis excerpt. Grouped for inspection; use the full readable file to retain original ordering.'],
]) {
  const program = t.program(body, ast.program.directives, ast.program.sourceType);
  const content = `/* ${note} Generated from the pinned sample; original variable names are not recovered. */\n` + generate(program, { comments: true }).code + '\n';
  fs.writeFileSync(path.join(directory, `zhihuishu-2.${name}.js`), content);
}

const changes = {};
for (const pass of report.passes) changes[pass.name] = (changes[pass.name] || 0) + pass.changes;
if (report.input.sha256 !== baseline.inputSha256) throw new Error('Comparison baseline does not match this sample.');
const comparison = {
  inputSha256: report.input.sha256,
  baseline: { file: fs.existsSync(path.join(directory, 'zhihuishu-2.baseline.js')) ? 'artifacts/zhihuishu-2.baseline.js' : null, summary: 'test/fixtures/zhihuishu-2.baseline.json', bytes: baseline.bytes, metrics: baseline.metrics },
  readable: { file: 'artifacts/zhihuishu-2.readable.js', bytes: report.output.bytes, metrics: report.residuals.after },
  changes,
  librarySections: sections,
  analysisExcerpts: { business: 'artifacts/zhihuishu-2.business.js', libraries: 'artifacts/zhihuishu-2.libraries.js' },
  diagnostics: report.diagnostics,
};
fs.writeFileSync(path.join(directory, 'zhihuishu-2.comparison.json'), JSON.stringify(comparison, null, 2) + '\n');

function classSyntaxMetrics(classAst) {
  const metrics = { classDeclarations: 0, classExpressions: 0, constructors: 0, instanceMethods: 0, staticMethods: 0, prototypeMethodAssignments: 0 };
  t.traverseFast(classAst, node => {
    if (t.isClassDeclaration(node)) metrics.classDeclarations++;
    if (t.isClassExpression(node)) metrics.classExpressions++;
    if (t.isClassMethod(node)) {
      if (node.kind === 'constructor') metrics.constructors++;
      else if (node.static) metrics.staticMethods++;
      else metrics.instanceMethods++;
    }
    if (t.isAssignmentExpression(node, { operator: '=' }) && t.isMemberExpression(node.left) && t.isFunctionExpression(node.right)) {
      const owner = node.left.object;
      if (t.isMemberExpression(owner) && (owner.computed ? t.isStringLiteral(owner.property, { value: 'prototype' }) : t.isIdentifier(owner.property, { name: 'prototype' }))) {
        metrics.prototypeMethodAssignments++;
      }
    }
  });
  return metrics;
}

function writeClassPreview(classResult, bindingName = 'pt', outputStem = 'class-preview') {
  const candidates = [];
  const targetMethods = new Set(['setPublicKey', 'setPrivateKey', 'getKey', 'encrypt', 'decrypt', 'getPrivateKey', 'getPublicKey']);
  traverse(parser.parse(classResult.code), {
    Class(classPath) {
      const node = classPath.node;
      const name = node.id && node.id.name || (classPath.parentPath.isVariableDeclarator() && t.isIdentifier(classPath.parentPath.node.id) ? classPath.parentPath.node.id.name : null);
      const methods = node.body.body.filter(method => t.isClassMethod(method)).map(method => method.key.name || method.key.value);
      const score = (name === bindingName ? 100 : 0) + methods.filter(name => targetMethods.has(name)).length;
      let excerpt = node;
      if (t.isClassExpression(node)) {
        if (classPath.parentPath.isVariableDeclarator()) {
          excerpt = t.variableDeclaration(classPath.parentPath.parentPath.node.kind, [t.cloneNode(classPath.parentPath.node, true)]);
        } else if (classPath.parentPath.isAssignmentExpression()) {
          excerpt = t.expressionStatement(t.cloneNode(classPath.parentPath.node, true));
        } else {
          excerpt = t.expressionStatement(t.cloneNode(node, true));
        }
      }
      candidates.push({ name, score, excerpt, node, path: classPath, line: node.loc.start.line, endLine: node.loc.end.line });
    },
  });
  candidates.sort((left, right) => right.score - left.score || left.line - right.line);
  const selected = candidates.find(candidate => candidate.name === bindingName);
  const previewFile = `artifacts/zhihuishu-2.${outputStem}.js`;
  const note = selected
    ? `Analysis excerpt only; not a standalone runnable module.\n * Full generated source: artifacts/zhihuishu-2.classes.js:${selected.line}-${selected.endLine}.\n * Original/generated binding: ${selected.name || '(anonymous class)'}. Names are not recovered or renamed.\n * The complete class is shown; surrounding closure helpers and initialization remain in the full file.`
    : `Analysis excerpt only; not a standalone runnable module.\n * No class named ${bindingName} was produced; inspect zhihuishu-2.classes.report.json modernization.skipped for the reasons.`;
  const parent = selected && bindingName === 'lt' && t.isIdentifier(selected.node.superClass)
    ? candidates.find(candidate => candidate.name === selected.node.superClass.name) : null;
  const related = parent ? [parent, selected] : selected ? [selected] : [];
  let content = `/* ${note} */\n`;
  for (const item of related) {
    content += `\n/* Complete class ${item.name}; full file lines ${item.line}-${item.endLine}. */\n`;
    content += generate(item.excerpt, { comments: true }).code + '\n';
  }
  const runtimeStatements = new Set();
  let retainedPrototypeAssignments = 0;
  if (selected && bindingName === 'O') {
    const converted = classResult.report.modernization.converted.find(item => item.name === bindingName);
    const aliases = new Set([bindingName, ...converted.aliases]);
    selected.path.findParent(parent => parent.isProgram()).traverse({
      AssignmentExpression(assignment) {
        const left = assignment.get('left');
        if (!left.isMemberExpression() || !left.get('object').isMemberExpression()) return;
        const prototype = left.get('object');
        const key = prototype.node.computed ? prototype.node.property.value : prototype.node.property.name;
        const object = prototype.get('object');
        if (key !== 'prototype' || !object.isIdentifier() || !aliases.has(object.node.name)) return;
        if (object.scope.getBinding(object.node.name) !== selected.path.scope.getBinding(object.node.name)) return;
        const member = left.node.computed ? left.node.property.value : left.node.property.name;
        if (!['am', 'DB', 'DM', 'DV', 'FV', 'F1', 'F2'].includes(member) || assignment.findParent(parent => parent.isClass())) return;
        const statement = assignment.findParent(parent => parent.isExpressionStatement() || parent.isVariableDeclaration());
        if (statement) { runtimeStatements.add(statement.node); retainedPrototypeAssignments++; }
      },
    });
    if (runtimeStatements.size) {
      content += '\n/* Runtime prototype setup is intentionally kept at its original full-file positions.\n'
        + ' * The following complete statements are juxtaposed for reading only.\n'
        + ' * Constructor aliases and intervening initialization still belong to the surrounding closure.\n'
        + ' * Do not move these statements immediately after the class in executable code. */\n';
    }
  }
  const runtimeSections = [...runtimeStatements].sort((left, right) => left.start - right.start);
  for (const statement of runtimeSections) {
    content += `\n/* Full file lines ${statement.loc.start.line}-${statement.loc.end.line}; original runtime installation. */\n`;
    content += classResult.code.slice(statement.start, statement.end) + '\n';
  }
  fs.writeFileSync(path.join(root, previewFile), content);
  return selected ? {
    file: previewFile, binding: selected.name, line: selected.line, endLine: selected.endLine,
    relatedClasses: related.map(item => ({ binding: item.name, line: item.line, endLine: item.endLine })),
    runtimeSections: runtimeSections.map(item => ({ line: item.loc.start.line, endLine: item.loc.end.line })),
    retainedPrototypeAssignments,
  } : { file: previewFile, binding: null };
}

function prototypeInventory(code, file) {
  const prototypeAst = parser.parse(code);
  const records = [];
  const sections = new WeakMap();
  const propertyName = node => node.computed ? t.isStringLiteral(node.property) ? node.property.value : null : node.property.name;
  const compact = node => generate(node, { compact: true, comments: false }).code;
  const groupCounts = () => ({
    methodAssignments: { direct: 0, conditional: 0, directOutsideClass: 0, conditionalOutsideClass: 0, classStaticBlock: 0, classBody: 0 },
    dataAssignments: 0, prototypeReplacements: 0, builtinOrDynamicReads: 0,
    byPlacement: Object.fromEntries(['outsideClass', 'classStaticBlock', 'classBody'].map(name => [name, {
      methodAssignments: 0, dataAssignments: 0, prototypeReplacements: 0, builtinOrDynamicReads: 0,
    }])),
  });
  function constructorName(objectPath, seen = new Set()) {
    if (objectPath.isThisExpression()) {
      const classPath = objectPath.findParent(parent => parent.isClass());
      if (classPath && classPath.node.id) return classPath.node.id.name;
    }
    if (!objectPath.isIdentifier()) return compact(objectPath.node);
    const binding = objectPath.scope.getBinding(objectPath.node.name);
    if (!binding || seen.has(binding)) return objectPath.node.name;
    seen.add(binding);
    if (binding.kind === 'param') return `${objectPath.node.name} (parameter at line ${binding.identifier.loc && binding.identifier.loc.start.line || '?'})`;
    if (binding.path.isVariableDeclarator()) {
      const init = binding.path.get('init');
      const writes = binding.constantViolations.filter(write => write.node !== binding.path.node);
      if (init.isIdentifier() && writes.length === 0) return constructorName(init, seen);
      const assigned = writes.filter(write => write.isAssignmentExpression({ operator: '=' }) && write.get('right').isIdentifier());
      if (!init.node && assigned.length === writes.length && assigned.length && new Set(assigned.map(write => write.node.right.name)).size === 1) {
        return constructorName(assigned[0].get('right'), seen);
      }
    }
    return objectPath.node.name;
  }
  function isFunctionValue(value) {
    if (value.isFunctionExpression() || value.isArrowFunctionExpression()) return true;
    if (value.isConditionalExpression()) return isFunctionValue(value.get('consequent')) && isFunctionValue(value.get('alternate'));
    if (!value.isIdentifier()) return false;
    const binding = value.scope.getBinding(value.node.name);
    return !!binding && (binding.path.isFunctionDeclaration() || binding.path.isVariableDeclarator()
      && (binding.path.get('init').isFunctionExpression() || binding.path.get('init').isArrowFunctionExpression()));
  }
  function addCount(counts, record) {
    const placement = record.placement === 'outside-class' ? 'outsideClass' : record.placement === 'class-static-block' ? 'classStaticBlock' : 'classBody';
    counts.byPlacement[placement][record.category === 'methodAssignment' ? 'methodAssignments' : record.category]++;
    if (record.category === 'methodAssignment') {
      counts.methodAssignments[record.conditional ? 'conditional' : 'direct']++;
      if (record.placement === 'outside-class') counts.methodAssignments[record.conditional ? 'conditionalOutsideClass' : 'directOutsideClass']++;
      else counts.methodAssignments[record.placement === 'class-static-block' ? 'classStaticBlock' : 'classBody']++;
    } else counts[record.category]++;
  }
  traverse(prototypeAst, {
    'MemberExpression|OptionalMemberExpression'(prototypePath) {
      if (propertyName(prototypePath.node) !== 'prototype') return;
      const top = prototypePath.findParent(parent => parent.parentPath && parent.parentPath.isProgram());
      if (top && !sections.has(top.node)) sections.set(top.node, libraryTag(top.node) || 'business');
      const staticBlock = prototypePath.findParent(parent => parent.isStaticBlock());
      const classPath = prototypePath.findParent(parent => parent.isClass());
      const rawOwner = compact(prototypePath.node.object);
      const family = constructorName(prototypePath.get('object'));
      const record = {
        family, rawOwner, section: top ? sections.get(top.node) : 'business',
        line: prototypePath.node.loc.start.line, column: prototypePath.node.loc.start.column,
        placement: staticBlock ? 'class-static-block' : classPath ? 'class-body' : 'outside-class',
        containingClass: classPath && classPath.node.id ? classPath.node.id.name : null,
        category: 'builtinOrDynamicReads', conditional: false, member: null,
      };
      let use = prototypePath.parentPath;
      if (use.isAssignmentExpression() && use.node.left === prototypePath.node) {
        record.category = 'prototypeReplacements';
        record.reason = 'Whole prototype replacement; may implement delegation, inheritance, or dynamic setup.';
      } else if ((use.isMemberExpression() || use.isOptionalMemberExpression()) && use.node.object === prototypePath.node) {
        record.member = propertyName(use.node) || `[${compact(use.node.property)}]`;
        let nested = false;
        while (use.parentPath.isMemberExpression() && use.parentPath.node.object === use.node) { use = use.parentPath; nested = true; }
        const assignment = use.parentPath;
        if (assignment.isAssignmentExpression() && assignment.node.left === use.node) {
          if (!nested && record.member !== 'constructor' && assignment.node.operator === '=' && isFunctionValue(assignment.get('right'))) {
            record.category = 'methodAssignment';
            for (let ancestor = assignment.parentPath; ancestor && !ancestor.isFunction() && !ancestor.isStaticBlock(); ancestor = ancestor.parentPath) {
              if (ancestor.isConditionalExpression() || ancestor.isIfStatement() || ancestor.isLogicalExpression() || ancestor.isSwitchCase() || ancestor.isLoop()) record.conditional = true;
            }
            if (assignment.get('right').isConditionalExpression()) record.conditional = true;
            record.reason = record.conditional ? 'Runtime-selected prototype method installation; retain the branch condition.' : 'Direct prototype method installation.';
          } else {
            record.category = 'dataAssignments';
            record.reason = record.member === 'constructor' ? 'Constructor metadata assignment.' : 'Shared prototype data or dynamic property copy; not an instance field.';
          }
        } else if (assignment.isUpdateExpression() || assignment.isUnaryExpression({ operator: 'delete' })) {
          record.category = 'dataAssignments';
          record.reason = 'Dynamic update or deletion of a prototype property.';
        } else {
          record.reason = 'Semantic property read/call through a prototype; not a class method installation.';
        }
      } else {
        record.reason = use.isCallExpression() ? 'Prototype passed to a call, possibly for descriptors or inheritance.' : 'Prototype value read or used in a dynamic object model.';
      }
      const ownerBinding = prototypePath.get('object').isIdentifier() && prototypePath.scope.getBinding(prototypePath.node.object.name);
      if (!ownerBinding && t.isIdentifier(prototypePath.node.object) && ['Object', 'Function', 'Array', 'String', 'Number', 'RegExp', 'Error'].includes(rawOwner)) {
        record.builtin = true;
        record.reason = 'Built-in prototype access used by library semantics; not obfuscation scaffolding.';
      }
      if (record.section === 'CryptoJS') record.model = 'CryptoJS delegation/init object model';
      records.push(record);
    },
  });
  const counts = groupCounts();
  const families = new Map();
  for (const record of records) {
    addCount(counts, record);
    const key = `${record.section}:${record.family}`;
    if (!families.has(key)) families.set(key, { family: record.family, section: record.section, accesses: 0, owners: [], lines: [], ...groupCounts() });
    const family = families.get(key);
    family.accesses++;
    if (!family.owners.includes(record.rawOwner)) family.owners.push(record.rawOwner);
    if (!family.lines.includes(record.line)) family.lines.push(record.line);
    addCount(family, record);
  }
  return {
    file,
    totalTextOccurrences: (code.match(/\.prototype\b|\[\s*['"]prototype['"]\s*\]/g) || []).length,
    dotPrototypeMemberTextOccurrences: (code.match(/\.prototype\./g) || []).length,
    astPrototypeMemberAccesses: records.length,
    ...counts,
    families: [...families.values()].sort((left, right) => right.accesses - left.accesses || (left.family < right.family ? -1 : left.family > right.family ? 1 : 0)),
    accesses: records,
  };
}

// Start again from the pinned original source, so the map always references the
// original input rather than a second-generation readable artifact.
const classResult = deobfuscate(source, {
  filename: path.basename(filename), sourceMaps: true, profile: 'readable', modernize: 'class',
});
const classReport = writeArtifact('zhihuishu-2.classes', classResult);
const classComparison = {
  inputSha256: classReport.input.sha256,
  previousClassBaseline: { summary: 'test/fixtures/zhihuishu-2.classes-baseline.json', savedArtifacts: 'artifacts/v2.2.0/', ...classBaseline },
  prototypeInventory: 'artifacts/zhihuishu-2.prototype-inventory.json',
  readable: { file: comparison.readable.file, bytes: report.output.bytes, sha256: report.output.sha256, syntax: classSyntaxMetrics(ast) },
  classes: { file: 'artifacts/zhihuishu-2.classes.js', bytes: classReport.output.bytes, sha256: classReport.output.sha256, syntax: classSyntaxMetrics(parser.parse(classResult.code)) },
  modernization: classReport.modernization,
  preview: writeClassPreview(classResult),
  additionalPreviews: {
    bigInteger: writeClassPreview(classResult, 'O', 'big-integer-preview'),
    rsa: writeClassPreview(classResult, 'lt', 'rsa-preview'),
  },
  diagnostics: classReport.diagnostics,
};
if (classComparison.inputSha256 !== comparison.inputSha256) throw new Error('Class and readable artifacts must refer to the same original input.');
if (classComparison.inputSha256 !== classBaseline.inputSha256) throw new Error('Class coverage baseline does not match this sample.');
fs.writeFileSync(path.join(directory, 'zhihuishu-2.classes.comparison.json'), JSON.stringify(classComparison, null, 2) + '\n');
const prototypes = {
  schemaVersion: 1,
  inputSha256: classReport.input.sha256,
  previousClassBaseline: classBaseline,
  interpretation: 'Text counts are syntax indicators. Prototype accesses also implement shared data, built-in calls, dynamic delegation and inheritance; they are not all obfuscation. Class static-block installations are counted separately from scattered assignments outside classes.',
  readable: prototypeInventory(result.code, comparison.readable.file),
  classes: prototypeInventory(classResult.code, classComparison.classes.file),
};
const beforeDirect = prototypes.readable.methodAssignments.directOutsideClass;
const afterDirect = prototypes.classes.methodAssignments.directOutsideClass;
prototypes.coverage = {
  directMethodInstallationsBefore: beforeDirect,
  directMethodInstallationsOutsideClassesAfter: afterDirect,
  directMethodInstallationReduction: beforeDirect ? (beforeDirect - afterDirect) / beforeDirect : null,
  note: 'This measures direct method-installation syntax moved out of scattered assignments, not the elimination of every semantic prototype access.',
};
fs.writeFileSync(path.join(directory, 'zhihuishu-2.prototype-inventory.json'), JSON.stringify(prototypes, null, 2) + '\n');
const modernization = classReport.modernization;
console.log(JSON.stringify({
  output: comparison.readable.file,
  businessView: comparison.analysisExcerpts.business,
  comparison: 'artifacts/zhihuishu-2.comparison.json',
  classes: classComparison.classes.file,
  classPreview: classComparison.preview.file,
  classComparison: 'artifacts/zhihuishu-2.classes.comparison.json',
  prototypeInventory: 'artifacts/zhihuishu-2.prototype-inventory.json',
  modernization: {
    mode: modernization.mode,
    classesConverted: modernization.classesConverted,
    prototypeMethodsConverted: modernization.prototypeMethodsConverted,
    staticMethodsConverted: modernization.staticMethodsConverted,
    skipped: modernization.skipped.length,
  },
  decoded: changes['decode-string-arrays'],
  iterations: report.iterations,
  converged: report.converged,
  before: baseline.metrics,
  after: report.residuals.after,
}, null, 2));
