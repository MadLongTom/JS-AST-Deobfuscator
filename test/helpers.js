'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { deobfuscate } = require('../src/index.js');

function serializeObserved(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item === undefined) return { $primitive: 'undefined' };
    if (typeof item === 'number') {
      if (Object.is(item, -0)) return { $primitive: 'negative-zero' };
      if (Number.isNaN(item)) return { $primitive: 'NaN' };
      if (item === Infinity) return { $primitive: 'Infinity' };
      if (item === -Infinity) return { $primitive: '-Infinity' };
    }
    if (typeof item === 'bigint') return { $primitive: 'bigint', value: item.toString() };
    return item;
  });
}

// Only call this helper with trusted strings declared in this test suite.
// Real-world fixtures are parsed and transformed, never executed.
function observeTrustedProgram(source) {
  const context = vm.createContext({});
  let exception = null;
  try {
    new vm.Script(source).runInContext(context, { timeout: 1000 });
  } catch (error) {
    exception = error.name;
  }
  return {
    exception,
    result: serializeObserved(context.result),
    trace: serializeObserved(context.trace),
  };
}

function assertPreserved(source, options = {}) {
  const transformed = deobfuscate(source, options);
  assert.deepEqual(observeTrustedProgram(transformed.code), observeTrustedProgram(source));
  return transformed;
}

module.exports = { assertPreserved, observeTrustedProgram };
