'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deobfuscate } = require('../src');
const { loadSamples, transformSample, passTotals } = require('../scripts/chaoxing-sample.cjs');

const samples = loadSamples();

test('Chaoxing fixtures are offline byte-pinned public script snapshots', () => {
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map(sample => sample.name), ['video-index', 'videojs-ext']);
  assert.equal(samples.reduce((sum, sample) => sum + sample.bytes, 0), 385617);
  // loadSamples verifies both bytes and SHA-256 before returning any source.
  assert.ok(samples.every(sample => sample.sha256.length === 64 && sample.source.length > 100000));
});

for (const sample of samples) {
  test(`${sample.name}: static decoder family removal preserves legacy data eval and public entry points`, { timeout: 120000 }, () => {
    const { result, validation } = transformSample(sample);
    assert.equal(validation.passed, true);
    assert.equal(validation.inputSdkExecuted, false);
    assert.equal(result.report.profile, 'readable');
    assert.equal(result.report.converged, true);
    assert.ok(passTotals(result.report)['decode-string-arrays'] >= sample.minimumDecodedCalls);
    assert.equal(validation.before.directEvalCalls.length, 8);
    assert.equal(validation.after.directEvalCalls.length, 8);
    assert.equal(validation.after.familyIdentifiers.length, 0);
    assert.equal(validation.after.decoderFamilyCalls.length, 0);
    assert.equal(validation.after.decoderAliasDeclarations.length, 0);
    assert.deepEqual(validation.after.directEvalCalls.map(call => call.signature), sample.evalSignatures);
    assert.ok(validation.after.markers.every(marker => marker.present));
    assert.ok(validation.after.functions.every(fn => fn.present));
    assert.equal(result.report.assumptions.length, 8);
    assert.ok(validation.naming.renamed > 0);
    assert.ok(validation.naming.neutral > 0);
    assert.equal(validation.naming.originalNamesRecovered, false);
    assert.equal(result.map.sourcesContent[0], sample.source);
    // The build parses and transforms only. The real SDK is never required,
    // imported, evaluated or launched, even by the test harness.
  });
}

test('a real Chaoxing fixture remains blocked by default without the explicit data contract', { timeout: 120000 }, () => {
  const sample = samples[0];
  const result = deobfuscate(sample.source, {
    filename: sample.filename,
    profile: 'readable',
    passes: ['normalize-literals', 'decode-string-arrays'],
    maxIterations: 2,
  });
  assert.equal(passTotals(result.report)['decode-string-arrays'], 0);
  assert.equal(result.report.assumptions.length, 0);
  assert.ok(result.report.diagnostics.some(diagnostic => diagnostic.code === 'UNSUPPORTED_DYNAMIC_SCOPE'));
});
