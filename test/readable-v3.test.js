'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { deobfuscate } = require('../src/index.js');
const { assertPreserved } = require('./helpers.js');

const statementOptions = { profile: 'readable', passes: ['normalize-statements'] };

function expressionStatements(code, type) {
  let count = 0;
  traverse(parser.parse(code), {
    ExpressionStatement(path) { if (path.node.expression.type === type) count++; },
  });
  return count;
}

test('constant folding exposes truthiness of allocations without effects', () => {
  const { code } = assertPreserved('globalThis.result = [!![], !!{}, ![], !{}, !!function () {}];', {
    passes: ['constant-fold'],
  });
  const values = parser.parse(code).program.body[0].expression.right.elements;
  assert.ok(values.every((value) => value.type === 'BooleanLiteral'));
  assert.deepEqual(values.map((value) => value.value), [true, true, false, false, true]);
});

test('truthiness folding does not discard initializer or computed-key effects', () => {
  assertPreserved(`
    globalThis.trace = [];
    globalThis.result = [!![trace.push('array')], !{ [trace.push('key')]: 1 }, !!{ value: trace.push('value') }];
  `, { passes: ['constant-fold', 'dead-code'] });
});

test('truthiness folding retains spread iterator effects and throwing class evaluation', () => {
  for (const source of [
    `globalThis.trace = []; const source = { [Symbol.iterator]: function* () { trace.push('iterated'); yield 1; } }; globalThis.result = !![...source];`,
    `globalThis.result = !!class extends missingBase {};`,
  ]) assertPreserved(source, { passes: ['constant-fold', 'dead-code'] });
});

test('readability normalization splits comma statements in evaluation order', () => {
  const { code } = assertPreserved(`
    globalThis.trace = [];
    trace.push('first'), trace.push('second'), trace.push('third');
    globalThis.result = trace.join(',');
  `, statementOptions);
  assert.equal(expressionStatements(code, 'SequenceExpression'), 0);
});

test('readability normalization expands statement ternaries into branches', () => {
  const { code } = assertPreserved(`
    globalThis.trace = [];
    function condition() { trace.push('condition'); return false; }
    condition() ? trace.push('yes') : trace.push('no');
    globalThis.result = trace.length;
  `, statementOptions);
  assert.equal(expressionStatements(code, 'ConditionalExpression'), 0);
  assert.match(code, /\bif\s*\(/);
});

test('readability normalization expands discarded logical results without changing effects', () => {
  const { code } = assertPreserved(`
    globalThis.trace = [];
    function condition(value) { trace.push(value); return value; }
    condition(0) && trace.push('skipped-and');
    condition(1) && trace.push('and');
    condition('') || trace.push('or');
    condition('value') || trace.push('skipped-or');
    globalThis.result = trace.length;
  `, statementOptions);
  assert.equal(expressionStatements(code, 'LogicalExpression'), 0);
});

test('statement normalization preserves short circuiting inside consumed expressions', () => {
  assertPreserved(`
    globalThis.trace = [];
    function next() { trace.push('next'); return 3; }
    const values = [0 && next(), '' || next(), null ?? next(), 0 ?? next()];
    globalThis.result = values;
  `, statementOptions);
});

test('statement normalization preserves nullish coalescing semantics', () => {
  assertPreserved(`
    globalThis.trace = [];
    0 ?? trace.push('wrong-zero');
    false ?? trace.push('wrong-false');
    null ?? trace.push('null');
    undefined ?? trace.push('undefined');
    globalThis.result = trace.length;
  `, statementOptions);
});

test('statement normalization preserves loop headers and continue updates', () => {
  assertPreserved(`
    globalThis.trace = [];
    for (var i = 0, j = 0; i < 3; i++, j++) {
      if (i === 1) continue;
      trace.push([i, j]);
    }
    globalThis.result = [i, j];
  `, statementOptions);
});

test('splitting a string expression cannot introduce a use strict directive', () => {
  assertPreserved(`
    function read() { ('use strict', 0); return this === undefined; }
    globalThis.result = read();
  `, statementOptions);
});

test('normalization preserves value versus Reference semantics for call targets', () => {
  assertPreserved(`
    (function () {
      'use strict';
      const object = { read: function () { return this === undefined; } };
      globalThis.result = [(0, object.read)(), (true ? object.read : null)(), (true && object.read)()];
    })();
  `, statementOptions);
});

test('a branch expansion preserves dangling else ownership', () => {
  assertPreserved(`
    globalThis.trace = [];
    if (true) false ? trace.push('wrong') : trace.push('inner');
    else trace.push('outer');
    globalThis.result = trace;
  `, statementOptions);
});

test('comma normalization preserves labeled loops and their continue target', () => {
  assertPreserved(`
    globalThis.trace = [];
    outer: for (var i = 0; i < 3; i++) {
      for (var j = 0; j < 2; j++) {
        trace.push(i), trace.push(j);
        if (j === 0) continue outer;
      }
    }
    globalThis.result = trace;
  `, statementOptions);
});

test('readable profile accepts an explicit empty pass selection', () => {
  const { code, report } = deobfuscate('globalThis.result = 1 + 2;', { profile: 'readable', passes: [] });
  assert.match(code, /1\s*\+\s*2/);
  assert.deepEqual(report.passes, []);
});

test('unknown readability profiles are rejected', () => {
  assert.throws(() => deobfuscate('1;', { profile: 'unsafe' }), (error) => error.code === 'INVALID_OPTIONS');
});

test('safe remains the default profile and explicit safe produces identical code', () => {
  const source = 'globalThis.result = 1 + 2;';
  const implicit = deobfuscate(source);
  const explicit = deobfuscate(source, { profile: 'safe' });
  assert.equal(implicit.code, explicit.code);
  assert.equal(implicit.report.profile, 'safe');
  assert.equal(explicit.report.profile, 'safe');
});

test('readability reports count input and output residuals using the same metric schema', () => {
  const source = `globalThis.trace = []; trace.push(1), trace.push(2); globalThis.result = trace.length;`;
  const { report } = deobfuscate(source, statementOptions);
  assert.equal(report.profile, 'readable');
  const fields = [
    'nodes', 'obfuscatedBindings', 'obfuscatedAliasDeclarations', 'dispatcherLoops',
    'proxyFunctionCandidates', 'sequenceExpressions', 'conditionalExpressions', 'sourceSelfDefensePatterns',
  ];
  for (const stage of ['before', 'after']) {
    for (const field of fields) {
      assert.ok(Number.isInteger(report.residuals[stage][field]) && report.residuals[stage][field] >= 0,
        `${stage}.${field} should be a nonnegative integer`);
    }
  }
  assert.equal(report.residuals.before.sequenceExpressions, 1);
  assert.equal(report.residuals.after.sequenceExpressions, 0);
  assert.equal(report.residuals.after.nodes > 0, true);
});

test('sequence returns become ordered statements followed by the returned value', () => {
  const { code } = assertPreserved(`
    globalThis.trace = [];
    function read() { return trace.push('first'), trace.push('second'), 7; }
    globalThis.result = read();
  `, statementOptions);
  let sequenceReturns = 0;
  traverse(parser.parse(code), {
    ReturnStatement(path) { if (path.node.argument && path.node.argument.type === 'SequenceExpression') sequenceReturns++; },
  });
  assert.equal(sequenceReturns, 0);
});

test('splitting declarations preserves TDZ and initializer order', () => {
  for (const source of [
    `(function () { let first = second, second = 1; globalThis.result = first; })();`,
    `globalThis.trace = []; var first = trace.push('first'), second = trace.push('second'); globalThis.result = [first, second];`,
  ]) assertPreserved(source, statementOptions);
});

test('both profiles transform untrusted source without running its side effects', () => {
  const key = '__READABLE_PROFILE_INPUT_EXECUTED__';
  delete globalThis[key];
  try {
    for (const profile of ['safe', 'readable']) {
      deobfuscate('globalThis.__READABLE_PROFILE_INPUT_EXECUTED__ = true; throw new Error("must not run");', { profile });
      assert.equal(globalThis[key], undefined);
    }
  } finally {
    delete globalThis[key];
  }
});

test('CLI exposes readable profile and rejects unsupported profile names', () => {
  const bin = path.join(__dirname, '../bin/js-ast-deobfuscator.js');
  const source = 'globalThis.trace = []; trace.push(1), trace.push(2);';
  const invoke = (profile) => spawnSync(process.execPath, [bin, '-', '--profile', profile, '--passes', 'normalize-statements'], {
    input: source, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  const readable = invoke('readable');
  assert.equal(readable.status, 0, readable.stderr);
  assert.equal(expressionStatements(readable.stdout, 'SequenceExpression'), 0);
  const invalid = invoke('unsupported');
  assert.ok(invalid.status !== null && invalid.status !== 0);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /profile/);
});
