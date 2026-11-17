'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { deobfuscate } = require('../src');
const { extractModules } = require('./extract-modules.cjs');

const root = path.resolve(__dirname, '..');
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/netease-core-2.28.5.metadata.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'test/fixtures', metadata.filename), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
if (hash(source) !== metadata.sha256) throw new Error('The pinned SDK fixture no longer matches its provenance.');
const result = deobfuscate(source, {
  filename: metadata.filename,
  profile: 'readable',
  renameBindings: true,
  maxIterations: 50,
  sourceMaps: true,
});
const directory = path.join(root, 'artifacts/yidun-core-2.28.5');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'readable.js');
const code = result.code + '\n//# sourceMappingURL=readable.js.map\n';
result.report.output = { bytes: Buffer.byteLength(code), sha256: hash(code) };
fs.writeFileSync(output, code);
fs.writeFileSync(output + '.map', JSON.stringify({ ...result.map, file: 'readable.js' }) + '\n');
fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(result.report, null, 2) + '\n');
const index = extractModules(output, path.join(directory, 'modules'));
const passChanges = {};
for (const pass of result.report.passes) passChanges[pass.name] = (passChanges[pass.name] || 0) + pass.changes;
const summary = {
  source: metadata,
  artifacts: { full: 'readable.js', sourceMap: 'readable.js.map', report: 'report.json', modules: 'modules/index.json' },
  converged: result.report.converged,
  iterations: result.report.iterations,
  moduleCount: index.bundles.reduce((count, bundle) => count + bundle.modules.length, 0),
  passChanges,
  residuals: result.report.residuals,
  naming: {
    renamed: result.report.readability.bindingsRenamed,
    evidenceBased: result.report.readability.evidenceBased,
    neutral: result.report.readability.neutral,
    preserved: result.report.readability.skipped.length,
  },
  interpretation: 'Structural metrics and naming labels describe static readability, not a proof of recovered original names or runtime equivalence. Source was never executed.',
};
fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ output, converged: summary.converged, iterations: summary.iterations, modules: summary.moduleCount, passChanges, naming: summary.naming }, null, 2));
if (!summary.converged || !passChanges['decode-string-arrays'] || !passChanges['decode-substituted-hex']) {
  console.error('The sample did not complete the expected static layers; inspect report.json.');
  process.exitCode = 1;
}
