'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deobfuscate } = require('../src/index.js');
const { assertPreserved } = require('./helpers.js');

test('constant-fold simplifies pure arithmetic without evaluating arbitrary calls', () => {
  const { code } = assertPreserved('globalThis.result = 1 + 2 * 3;', { passes: ['constant-fold'] });
  assert.match(code, /result\s*=\s*7/);
});

test('normalize-literals simplifies valid computed members including optional access', () => {
  const { code } = assertPreserved(`
    const object = { validName: 7, 'bad-key': 9 };
    globalThis.result = [object['validName'], object['bad-key'], object?.['validName']];
  `, { passes: ['normalize-literals'] });
  assert.match(code, /object\.validName/);
  assert.match(code, /object\?\.validName/);
  assert.match(code, /object\[['"]bad-key['"]\]/);
});

test('inline-constants propagates a private initialized primitive', () => {
  const { code } = assertPreserved('(function () { const value = 7; globalThis.result = value; })();', {
    passes: ['inline-constants'],
  });
  assert.match(code, /result\s*=\s*7/);
});

test('inline-objects resolves private immutable own data properties', () => {
  const { code } = assertPreserved('(function () { const table = { value: 7 }; globalThis.result = table.value; })();', {
    passes: ['inline-objects'],
  });
  assert.match(code, /result\s*=\s*7/);
});

test('inline-wrappers simplifies a private pure function called with literals', () => {
  const { code } = assertPreserved('(function () { function add(a, b) { return a + b; } globalThis.result = add(2, 3); })();', {
    passes: ['inline-wrappers', 'constant-fold'],
  });
  assert.match(code, /result\s*=\s*5/);
});

test('control-flow linearizes the canonical ordered switch dispatcher', () => {
  const source = `
    globalThis.trace = [];
    (function () {
      var order = '2|0|1'.split('|');
      var index = 0;
      while (true) {
        switch (order[index++]) {
          case '0': trace.push('zero'); continue;
          case '1': trace.push('one'); continue;
          case '2': trace.push('two'); continue;
        }
        break;
      }
      globalThis.result = trace.join(',');
    })();
  `;
  const { code } = assertPreserved(source, { passes: ['control-flow'] });
  assert.doesNotMatch(code, /\b(?:while|switch)\s*\(/);
});

test('control-flow leaves a dispatcher with externally used index semantically intact', () => {
  assertPreserved(`
    globalThis.trace = [];
    (function () {
      var order = '1|0'.split('|'), index = 0;
      while (true) {
        switch (order[index++]) {
          case '0': trace.push('zero'); continue;
          case '1': trace.push('one'); continue;
        }
        break;
      }
      globalThis.result = index;
    })();
  `, { passes: ['control-flow'] });
});

test('control-flow respects an explicit modification of String.prototype.split', () => {
  assertPreserved(`
    globalThis.trace = [];
    String.prototype.split = function () { return ['1', '0']; };
    (function () {
      var order = '0|1'.split('|'), index = 0;
      while (true) {
        switch (order[index++]) {
          case '0': trace.push('zero'); continue;
          case '1': trace.push('one'); continue;
        }
        break;
      }
      globalThis.result = trace.join(',');
    })();
  `, { passes: ['control-flow'] });
});

test('dead-code removes a provably false side-effect-free loop', () => {
  const { code } = assertPreserved('while (false) { missing(); } globalThis.result = 1;', {
    passes: ['dead-code'],
  });
  assert.doesNotMatch(code, /missing|\bwhile\b/);
});

test('custom pass receives AST and warning context and participates in reports', () => {
  const { code, report } = deobfuscate('globalThis.result = 1;', {
    passes: ['replace-one'],
    customPasses: [{
      name: 'replace-one',
      description: 'Test-only primitive replacement',
      run(ast, context) {
        assert.equal(context.options.maxIterations, 5);
        const right = ast.program.body[0].expression.right;
        if (right.value !== 1) return 0;
        right.value = 2;
        context.warn('TEST_WARNING', 'Test-only warning', { value: 1 });
        return 1;
      },
    }],
  });
  assert.match(code, /result\s*=\s*2/);
  assert.equal(report.totals.changes, 1);
  assert.ok(report.diagnostics.some((item) => item.code === 'TEST_WARNING' && item.level === 'warning'));
  assert.equal(report.passes[0].name, 'replace-one');
});

test('custom pass failures carry their pass name', () => {
  assert.throws(() => deobfuscate('1;', {
    passes: ['broken'],
    customPasses: [{ name: 'broken', description: 'Throws', run() { throw new Error('deliberate failure'); } }],
  }), (error) => error.code === 'PASS_ERROR' && error.passName === 'broken');
});

test('custom passes append to the default pipeline when no selection is supplied', () => {
  const { report } = deobfuscate('globalThis.result = 1;', {
    customPasses: [{ name: 'appended', description: 'No-op', run() { return 0; } }],
  });
  const firstIteration = report.passes.filter((pass) => pass.iteration === 1);
  assert.equal(firstIteration.at(-1).name, 'appended');
});

test('invalid and asynchronous pass results become PASS_ERROR', () => {
  for (const result of [undefined, -1, 1.5, Promise.resolve(0)]) {
    assert.throws(() => deobfuscate('1;', {
      passes: ['invalid-result'],
      customPasses: [{ name: 'invalid-result', run() { return result; } }],
    }), (error) => error.code === 'PASS_ERROR' && error.passName === 'invalid-result');
  }
});

test('AST fingerprints determine convergence even if a pass overcounts', () => {
  const { report } = deobfuscate('1;', {
    passes: ['overcount'],
    customPasses: [{ name: 'overcount', run() { return 1; } }],
  });
  assert.equal(report.converged, true);
  assert.equal(report.iterations, 1);
});

test('oscillating custom passes stop on a repeated program fingerprint', () => {
  const { report } = deobfuscate('globalThis.result = 1;', {
    passes: ['toggle'],
    customPasses: [{
      name: 'toggle',
      run(ast) { const value = ast.program.body[0].expression.right; value.value = value.value === 1 ? 2 : 1; return 1; },
    }],
  });
  assert.equal(report.converged, false);
  assert.equal(report.iterations, 2);
  assert.ok(report.diagnostics.some((item) => item.code === 'PIPELINE_CYCLE'));
});

test('the iteration bound is reported when a changed program has not settled', () => {
  const { report } = deobfuscate('globalThis.result = 1 + 2;', {
    passes: ['constant-fold'], maxIterations: 1,
  });
  assert.equal(report.converged, false);
  assert.equal(report.iterations, 1);
  assert.ok(report.diagnostics.some((item) => item.code === 'MAX_ITERATIONS'));
});
