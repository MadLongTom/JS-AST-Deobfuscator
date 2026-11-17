'use strict';

// All vendor input is treated as text/AST. Never require or execute a fixture.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { deobfuscate } = require('../src');
const { classifyDataEval } = require('../src/analysis/parenthesized-data-eval');

const root = path.resolve(__dirname, '..');
const fixtureDirectory = path.join(root, 'test/fixtures');
const options = Object.freeze({
  profile: 'readable', assumeDataEval: true, renameBindings: true,
  sourceMaps: true, sourceType: 'script', maxIterations: 50,
});
const hash = value => createHash('sha256').update(value).digest('hex');
const parse = code => parser.parse(code, { sourceType: 'script' });

function loadSamples() {
  const metadata = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'chaoxing.metadata.json'), 'utf8'));
  return metadata.samples.map(sample => {
    const sourceBytes = fs.readFileSync(path.join(fixtureDirectory, sample.filename));
    assert.equal(sourceBytes.length, sample.bytes, `${sample.name}: pinned byte length`);
    assert.equal(hash(sourceBytes), sample.sha256, `${sample.name}: pinned SHA-256`);
    return { ...sample, source: sourceBytes.toString('utf8') };
  });
}

function passTotals(report) {
  const totals = {};
  for (const pass of report.passes) totals[pass.name] = (totals[pass.name] || 0) + pass.changes;
  return totals;
}

function inspect(ast, sample) {
  const markers = new Map(), functions = new Map(), evalCalls = [], obfuscatedBindings = new Set();
  const familyIdentifiers = [], familyCalls = [], aliasDeclarations = [];
  const record = (map, key, p) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p.node.loc.start.line);
  };
  const aliases = [];
  const familyBindings = new Set();
  traverse(ast, {
    FunctionDeclaration(p) {
      if (p.node.id && p.parentPath.isProgram() && p.node.id.name === sample.decoderName) familyBindings.add(p.parentPath.scope.getBinding(p.node.id.name));
    },
    VariableDeclarator(p) { if (p.get('id').isIdentifier() && p.get('init').isIdentifier()) aliases.push(p); },
  });
  let added = true;
  while (added) {
    added = false;
    for (const alias of aliases) {
      const binding = alias.scope.getBinding(alias.node.id.name), target = alias.scope.getBinding(alias.node.init.name);
      if (binding && binding.constant && familyBindings.has(target) && !familyBindings.has(binding)) { familyBindings.add(binding); added = true; }
    }
  }
  traverse(ast, {
    Scopable(p) { for (const binding of Object.values(p.scope.bindings)) if (/^_0x[\da-f]+$/i.test(binding.identifier.name)) obfuscatedBindings.add(binding); },
    Identifier(p) {
      record(markers, p.node.name, p);
      if (sample.familyNames.includes(p.node.name)) familyIdentifiers.push({ name: p.node.name, line: p.node.loc.start.line });
    },
    StringLiteral(p) { record(markers, p.node.value, p); },
    FunctionDeclaration(p) { if (p.node.id) record(functions, p.node.id.name, p); },
    VariableDeclarator(p) {
      if (p.get('id').isIdentifier() && p.get('init').isIdentifier() && familyBindings.has(p.scope.getBinding(p.node.id.name))) aliasDeclarations.push({ name: p.node.id.name, line: p.node.loc.start.line });
    },
    CallExpression(p) {
      const callee = p.get('callee');
      if (callee.isIdentifier() && familyBindings.has(p.scope.getBinding(callee.node.name))) familyCalls.push({ name: callee.node.name, line: p.node.loc.start.line });
      if (!callee.isIdentifier({ name: 'eval' }) || p.scope.getBinding('eval')) return;
      const classification = classifyDataEval(p);
      const introducedNames = classification ? classification.introducedNames : [];
      const references = {};
      const owner = p.getFunctionParent();
      if (owner) owner.traverse({
        Function(inner) { inner.skip(); },
        ReferencedIdentifier(ref) { if (introducedNames.includes(ref.node.name)) references[ref.node.name] = (references[ref.node.name] || 0) + 1; },
      });
      evalCalls.push({ line: p.node.loc.start.line,
        signature: classification ? classification.kind + (introducedNames.length ? ':' + introducedNames.join(',') : '') : 'not-classified-before-decoding',
        introducedNames, introducedNameReferences: references,
        standalone: p.parentPath.isExpressionStatement(),
      });
    },
  });
  return {
    directEvalCalls: evalCalls,
    familyBindings: familyBindings.size,
    familyIdentifiers,
    decoderFamilyCalls: familyCalls,
    decoderAliasDeclarations: aliasDeclarations,
    obfuscatedBindingsRemaining: obfuscatedBindings.size,
    markers: sample.markers.map(value => ({ value, present: markers.has(value), lines: markers.get(value) || [] })),
    functions: sample.functions.map(name => ({ name, present: functions.has(name), lines: functions.get(name) || [] })),
  };
}

function validateSample(sample, result) {
  const before = inspect(parse(sample.source), sample);
  const after = inspect(parse(result.code), sample);
  const totals = passTotals(result.report);
  assert.equal(result.report.converged, true, `${sample.name}: pipeline convergence`);
  assert.ok(totals['decode-string-arrays'] >= sample.minimumDecodedCalls, `${sample.name}: expected string decoding coverage`);
  assert.equal(before.directEvalCalls.length, sample.evalSignatures.length, `${sample.name}: pinned original eval count`);
  assert.deepEqual(after.directEvalCalls.map(call => call.signature), sample.evalSignatures, `${sample.name}: original eval syntax remains`);
  for (const call of after.directEvalCalls) for (const name of call.introducedNames) assert.ok(call.introducedNameReferences[name] > 0, `${sample.name}: eval-introduced ${name} still referenced`);
  assert.equal(after.familyIdentifiers.length, 0, `${sample.name}: decoder/provider family names fully removed`);
  assert.equal(after.decoderFamilyCalls.length, 0, `${sample.name}: decoder aliases fully resolved`);
  assert.equal(after.decoderAliasDeclarations.length, 0, `${sample.name}: decoder aliases fully removed`);
  assert.ok(after.markers.every(marker => marker.present), `${sample.name}: critical API/string markers retained`);
  assert.ok(after.functions.every(fn => fn.present), `${sample.name}: named entry points retained`);
  assert.equal(result.report.assumptions.length, sample.evalSignatures.length, `${sample.name}: every eval assumption reported`);
  assert.ok(result.report.diagnostics.some(diagnostic => diagnostic.code === 'READABLE_DECODER_SCAFFOLD_REMOVED'));
  assert.ok(!result.report.diagnostics.some(diagnostic => ['UNSUPPORTED_DYNAMIC_SCOPE', 'STRING_DECODER_OPERATION_LIMIT', 'MAX_ITERATIONS'].includes(diagnostic.code)), `${sample.name}: no unresolved decoder limitation`);
  assert.ok(result.map && result.map.sources.includes(sample.filename), `${sample.name}: source map source`);
  assert.equal(result.map.sourcesContent[result.map.sources.indexOf(sample.filename)], sample.source, `${sample.name}: source map pins exact source content`);
  const naming = result.report.readability || {};
  return {
    passed: true, parsed: true, inputSdkExecuted: false,
    checks: ['pinned-input-hash', 'reparse', 'convergence', 'decoder-coverage', 'eval-count-and-shapes', 'eval-introduced-name-uses', 'decoder-family-and-alias-removal', 'critical-api-markers', 'reported-assumptions', 'source-map-content'],
    before, after, passTotals: totals,
    naming: { renamed: naming.bindingsRenamed || 0, evidenceBased: naming.evidenceBased || 0,
      neutral: naming.neutral || 0, preserved: naming.skipped ? naming.skipped.length : 0,
      obfuscatedBindingsRemaining: after.obfuscatedBindingsRemaining,
      originalNamesRecovered: false },
    limitation: 'Checks establish static readability coverage and retained syntax, not whole-SDK semantic equivalence. Data-only eval is an explicit contract assumption; response payloads are not available to this offline build. Neutral labels are not recovered business names.',
  };
}

function transformSample(sample) {
  const result = deobfuscate(sample.source, { ...options, filename: sample.filename });
  return { result, validation: validateSample(sample, result) };
}

function toolManifest() {
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : entry.isFile() ? [absolute] : [];
  });
  return [path.join(root, 'package.json'), path.join(root, 'package-lock.json'), ...walk(path.join(root, 'src'))].sort()
    .map(file => ({ path: path.relative(root, file).split(path.sep).join('/'), sha256: hash(fs.readFileSync(file)) }));
}

function buildAll(directory = path.join(root, 'artifacts/chaoxing')) {
  const samples = loadSamples(); // Fail all provenance checks before creating output.
  const built = samples.map(sample => ({ sample, ...transformSample(sample) }));
  const outputDirectory = path.resolve(directory);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const write = (filename, value) => fs.writeFileSync(path.join(outputDirectory, filename), value);
  const json = (filename, value) => write(filename, JSON.stringify(value, null, 2) + '\n');
  const manifest = toolManifest();
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const summary = {
    schemaVersion: 1, staticOnly: true, inputSdkExecuted: false, networkUsed: false,
    options, tool: { name: packageInfo.name, version: packageInfo.version, nodeVersion: process.version, sourceManifestSha256: hash(JSON.stringify(manifest)) },
    interpretation: 'Complete removal of the recognized string-table obfuscation for these pinned samples under explicit data-only eval assumptions. Vendor eval remains intact. Names are inferred or neutral; this is not recovered original source or proof of runtime equivalence.',
    results: [],
  };
  for (const { sample, result, validation } of built) {
    const basename = sample.name + '.js';
    const code = result.code + '\n//# sourceMappingURL=' + basename + '.map\n';
    const map = JSON.stringify({ ...result.map, file: basename }) + '\n';
    result.report.output = { bytes: Buffer.byteLength(code), sha256: hash(code) };
    write(basename, code);
    write(basename + '.map', map);
    json(sample.name + '.report.json', result.report);
    json(sample.name + '.validation.json', validation);
    summary.results.push({ name: sample.name, source: { filename: sample.filename, scriptPath: sample.scriptPath, bytes: sample.bytes, sha256: sample.sha256 },
      output: { filename: basename, ...result.report.output, lines: code.split('\n').length,
        sourceMap: { filename: basename + '.map', sha256: hash(map) } },
      converged: result.report.converged, iterations: result.report.iterations,
      passTotals: validation.passTotals, assumptions: result.report.assumptions,
      naming: validation.naming, residuals: result.report.residuals,
      evalCallsBefore: validation.before.directEvalCalls.length, evalCallsAfter: validation.after.directEvalCalls.length,
      decoderFamilyCallsBefore: validation.before.decoderFamilyCalls.length, decoderFamilyCallsAfter: validation.after.decoderFamilyCalls.length,
      decoderFamilyIdentifiersAfter: validation.after.familyIdentifiers.length, allCriticalMarkersPresent: true,
      validation: sample.name + '.validation.json', report: sample.name + '.report.json',
    });
  }
  json('tool-source-manifest.json', manifest);
  json('build-summary.json', summary);
  return { directory: outputDirectory, summary };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) throw new Error('Usage: node scripts/chaoxing-sample.cjs [--output directory]');
  const { directory, summary } = buildAll(args[1]);
  console.log(JSON.stringify({ directory, results: summary.results.map(result => ({ name: result.name,
    decoded: result.passTotals['decode-string-arrays'], converged: result.converged,
    evalCalls: result.evalCallsAfter, familyResiduals: result.decoderFamilyIdentifiersAfter, naming: result.naming })) }, null, 2));
}

module.exports = { options, hash, loadSamples, passTotals, inspect, validateSample, transformSample, buildAll };
