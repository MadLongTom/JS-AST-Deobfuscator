'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertPreserved } = require('./helpers');
const options = { modernize: 'class', passes: [] };

test('a sibling eval does not block class binding and strictness analysis elsewhere', () => {
  const { code, report } = assertPreserved(`(function () {
    function unrelated(text) { return eval(text); }
    function build() {
      function Item(value) { this.value = value; }
      Item.prototype.read = function () { return this.value; };
      return new Item(3).read();
    }
    globalThis.result = [build(), unrelated('1 + 2')];
  })();`, options);
  assert.match(code, /class Item/);
  assert.equal(report.modernization.classesConverted, 1);
});

test('a visible class binding and a method with direct eval remain protected', () => {
  for (const source of [
    `(function () { function Item(value) { this.value = value; } Item.prototype.read = function () { return this.value; }; eval('Item.extra = 3'); globalThis.result = new Item(3).read(); })();`,
    `(function () { function Item(value) { this.value = value; } Item.prototype.read = function () { return eval('this.value'); }; globalThis.result = new Item(3).read(); })();`,
  ]) {
    const { code, report } = assertPreserved(source, options);
    assert.doesNotMatch(code, /class Item/);
    assert.equal(report.modernization.classesConverted, 0);
  }
});
