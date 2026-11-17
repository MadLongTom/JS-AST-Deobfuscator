'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { deobfuscate } = require('../src/index.js');
const { assertPreserved, observeTrustedProgram } = require('./helpers.js');

const options = { passes: [], modernize: 'class' };

// All programs in this file are trusted test strings. Do not use this helper
// to execute downloaded or real-world deobfuscation fixtures.
function classes(code) {
  const found = [];
  traverse(parser.parse(code, { sourceType: 'unambiguous' }), {
    ClassDeclaration(path) { found.push(path.node); },
    ClassExpression(path) { found.push(path.node); },
  });
  return found;
}

const simple = `
  function Counter(value) { this.value = value; }
  Counter.prototype.add = function (delta) { return this.value + delta; };
  globalThis.result = new Counter(4).add(3);
`;

test('class modernization is disabled by default and with explicit false', () => {
  for (const settings of [{ passes: [] }, { passes: [], modernize: false }, { passes: [], modernize: undefined }]) {
    const { code } = assertPreserved(simple, settings);
    assert.equal(classes(code).length, 0);
    assert.match(code, /Counter\.prototype\.add\s*=\s*function/);
  }
});

test('an opted-in simple constructor and method become a valid runnable class', () => {
  const { code } = assertPreserved(simple, options);
  const found = classes(code);
  assert.equal(found.length, 1);
  assert.equal(found[0].id.name, 'Counter');
  assert.equal(found[0].body.body.filter(method => method.kind === 'constructor').length, 1);
  assert.ok(found[0].body.body.some(method => method.key.name === 'add' && !method.static));
  assert.doesNotMatch(code, /Counter\.prototype\.add\s*=/);
});

test('method assignments before the hoisted constructor retain behavior', () => {
  const source = `
    Item.prototype.read = function (offset) { return this.value + offset; };
    function Item(value) { this.value = value; }
    globalThis.result = new Item(8).read(2);
  `;
  const { code } = assertPreserved(source, options);
  assert.equal(classes(code).filter(node => node.id && node.id.name === 'Item').length, 1);
});

test('read-only constructor alias chains can still be constructed', () => {
  const source = `
    function Item(value) { this.value = value; }
    Item.prototype.read = function () { return this.value; };
    const Alias = Item;
    const AnotherAlias = Alias;
    globalThis.result = [new AnotherAlias(9).read(), AnotherAlias === Item];
  `;
  const { code } = assertPreserved(source, options);
  assert.equal(classes(code).filter(node => node.id && node.id.name === 'Item').length, 1);
});

test('an alias before the hoisted constructor remains initialized at the class anchor', () => {
  const source = `
    var A = Item;
    A.prototype.read = function () { return this.value; };
    function Item(value) { this.value = value; }
    globalThis.result = new A(8).read();
  `;
  const { code, report } = assertPreserved(source, options);
  assert.match(code, /\bA\s*=\s*Item\b/);
  assert.equal(classes(code).filter(node => node.id && node.id.name === 'Item').length, 1);
  assert.equal(report.modernization.classesConverted, 1);
});

test('same constructor spelling in separate lexical scopes is handled by binding', () => {
  const source = `
    function first() {
      function Item(value) { this.value = value; }
      Item.prototype.read = function () { return this.value + 1; };
      return new Item(2).read();
    }
    function second() {
      function Item(value) { this.value = value; }
      Item.prototype.read = function () { return this.value * 3; };
      return new Item(4).read();
    }
    globalThis.result = [first(), second()];
  `;
  const { code } = assertPreserved(source, options);
  assert.equal(classes(code).filter(node => node.id && node.id.name === 'Item').length, 2);
  assert.equal(classes(code).some(node => node.id && ['first', 'second'].includes(node.id.name)), false);
});

test('nested constructors inside a converted method remain live and match reported classes', () => {
  const source = `
    function Outer(value) { this.value = value; }
    Outer.prototype.run = function (offset) {
      function Inner(value) { this.value = value; }
      Inner.prototype.read = function (delta) { return this.value + delta; };
      return new Inner(this.value).read(offset);
    };
    globalThis.result = new Outer(5).run(3);
  `;
  const { code, report } = assertPreserved(source, options);
  const found = classes(code);
  assert.equal(report.modernization.classesConverted, found.length);
  assert.equal(report.modernization.converted.length, found.length);
  assert.ok(found.length >= 2, 'Both the outer and the nested constructor should be modernized.');
  assert.deepEqual(found.map(node => node.id && node.id.name).sort(), ['Inner', 'Outer']);
});

test('an unsafe candidate does not prevent a separate safe class conversion', () => {
  const source = `
    function Safe(value) { this.value = value; }
    Safe.prototype.read = function () { return this.value; };
    function Legacy(value) { this.value = value; return { value: value }; }
    Legacy.prototype.read = function () { return this.value; };
    globalThis.result = [new Safe(2).read(), Legacy(3).value];
  `;
  const { code } = assertPreserved(source, options);
  assert.deepEqual(classes(code).map(node => node.id && node.id.name), ['Safe']);
});

test('static methods, parameters and method statement bodies are preserved', () => {
  const source = `
    function Counter(value) { this.value = value; }
    Counter.prototype.compute = function (left, right) {
      var factor = left + right;
      this.value += factor;
      return [this.value, left, right];
    };
    Counter.from = function (seed) { return new Counter(seed); };
    globalThis.result = Counter.from(10).compute(2, 3);
  `;
  const { code } = assertPreserved(source, options);
  const found = classes(code);
  assert.equal(found.length, 1);
  const method = found[0].body.body.find(member => member.key.name === 'compute');
  const staticMethod = found[0].body.body.find(member => member.key.name === 'from');
  assert.deepEqual(method.params.map(parameter => parameter.name), ['left', 'right']);
  assert.equal(method.body.body.length, 3);
  assert.equal(staticMethod.static, true);
  assert.deepEqual(staticMethod.params.map(parameter => parameter.name), ['seed']);
});

test('class conversion does not install a method before its original assignment', () => {
  const source = `
    function Item() {}
    var before;
    try { before = new Item().read(); } catch (error) { before = error.name; }
    Item.prototype.read = function () { return 'installed'; };
    globalThis.result = [before, new Item().read()];
  `;
  assertPreserved(source, options);
});

test('observations between method installations retain the original timing', () => {
  const source = `
    function Item() {}
    Item.prototype.first = function () { return 'first'; };
    globalThis.result = [typeof Item.prototype.second];
    Item.prototype.second = function () { return 'second'; };
    globalThis.result.push(new Item().first(), new Item().second());
  `;
  assertPreserved(source, options);
});

test('variable-held constructor functions remain valid whether converted or skipped', () => {
  const source = `var Item=function(value){this.value=value};Item.prototype.read=function(){return this.value};globalThis.result=new Item(6).read();`;
  const { code } = assertPreserved(source, options);
  parser.parse(code);
});

test('a named recursive method retains its private self binding', () => {
  const source = `
    function Item(value) { this.value = value; }
    Item.prototype.count = function recur(depth) {
      return depth === 0 ? this.value : recur.call(this, depth - 1) + 1;
    };
    var item = new Item(2);
    var count = item.count;
    item.count = function () { return 100; };
    globalThis.result = count.call(item, 3);
  `;
  const { code } = assertPreserved(source, options);
  assert.match(code, /function recur\b/);
});

test('class strict mode does not change direct-eval variable visibility', () => {
  const source = `function Item(){}Item.prototype.read=function(){eval('var localValue=7');return typeof localValue};globalThis.result=new Item().read();`;
  assertPreserved(source, options);
});

test('arguments.callee inside a constructor remains valid', () => {
  const source = `function Item(value){this.value=arguments.callee===Item?value:-1}Item.prototype.read=function(){return this.value};globalThis.result=new Item(7).read();`;
  assertPreserved(source, options);
});

test('construction through an instance method is retained or explicitly warned', () => {
  const source = `function Item(){}Item.prototype.Factory=function(value){this.value=value};var item=new Item();globalThis.result=new item.Factory(9).value;`;
  const { code, report } = deobfuscate(source, options);
  parser.parse(code);
  const before = observeTrustedProgram(source), after = observeTrustedProgram(code);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    assert.ok(report.diagnostics.some(item => /constructib|construct|new method/i.test(JSON.stringify(item))), 'An unproved instance-method construction assumption must be explicit.');
  }
});

for (const [name, source] of [
  ['ordinary constructor calls', `function Item(value){this.value=value;return {value:value}}Item.prototype.read=function(){return this.value};globalThis.result=Item(3).value;`],
  ['ordinary calls through a comma expression', `function Item(value){return {value:value}}Item.prototype.read=function(){return this.value};globalThis.result=(0,Item)(3).value;`],
  ['ordinary calls through a conditional expression', `function Item(value){return {value:value}}Item.prototype.read=function(){return this.value};globalThis.result=(true?Item:null)(3).value;`],
  ['ordinary calls through immutable aliases', `function Item(value){this.value=value;return {value:value}}Item.prototype.read=function(){return this.value};const A=Item;const B=A;globalThis.result=B(3).value;`],
  ['call through constructor aliases', `function Item(value){this.value=value}Item.prototype.read=function(){return this.value};const A=Item;const B=A;var object={};B.call(object,5);globalThis.result=object.value;`],
  ['apply through constructor aliases', `function Item(value){this.value=value}Item.prototype.read=function(){return this.value};const A=Item;const B=A;var object={};B.apply(object,[6]);globalThis.result=object.value;`],
  ['dynamic prototype replacement', `function Item(value){this.value=value}Item.prototype=globalThis.dynamicPrototype||{read:function(){return this.value}};globalThis.result=new Item(7).read();`],
  ['getter and setter descriptors', `function Item(value){this.internal=value}Object.defineProperty(Item.prototype,'value',{get:function(){return this.internal},set:function(value){this.internal=value}});var item=new Item(3);item.value=8;globalThis.result=item.value;`],
  ['accessors in a prototype object', `function Item(value){this.internal=value}Item.prototype={get value(){return this.internal},set value(value){this.internal=value}};globalThis.result=new Item(8).value;`],
  ['constructing a prototype method', `function Item(){}Item.prototype.Factory=function(value){this.value=value};globalThis.result=new Item.prototype.Factory(9).value;`],
  ['constructing an aliased prototype method', `function Item(){}Item.prototype.Factory=function(value){this.value=value};const Factory=Item.prototype.Factory;const Alias=Factory;globalThis.result=new Alias(10).value;`],
  ['constructing a static method', `function Item(){}Item.prototype.read=function(){return this.value};Item.Factory=function(value){this.value=value};globalThis.result=new Item.Factory(8).value;`],
  ['constructing an aliased static method', `function Item(){}Item.prototype.read=function(){return this.value};Item.Factory=function(value){this.value=value};const Factory=Item.Factory;const Alias=Factory;globalThis.result=new Alias(8).value;`],
  ['constructing a conditionally selected static method', `function Item(){}Item.prototype.read=function(){return this.value};Item.Factory=function(value){this.value=value};globalThis.result=new (true?Item.Factory:null)(8).value;`],
]) {
  test(`unsafe class candidate is retained: ${name}`, () => {
    const { code } = assertPreserved(source, options);
    assert.equal(classes(code).filter(node => node.id && node.id.name === 'Item').length, 0);
  });
}

test('class modernization runs once after the iterative custom passes', () => {
  const seen = [];
  let calls = 0;
  const { code, report } = deobfuscate(simple, {
    modernize: 'class', passes: ['observe-before-class'], maxIterations: 5,
    customPasses: [{
      name: 'observe-before-class',
      run(ast) {
        let count = 0;
        traverse(ast, { ClassDeclaration() { count++; }, ClassExpression() { count++; } });
        seen.push(count);
        calls++;
        if (calls === 1) { ast.program.body.unshift({ type: 'EmptyStatement' }); return 1; }
        return 0;
      },
    }],
  });
  assert.equal(calls, 2);
  assert.deepEqual(seen, [0, 0]);
  assert.equal(classes(code).length, 1);
  assert.equal(report.modernization.classesConverted, 1);
  assert.deepEqual(observeTrustedProgram(code), observeTrustedProgram(simple));
});

test('class output is syntactically valid and repeat modernization is stable', () => {
  const first = deobfuscate(simple, options);
  const second = deobfuscate(first.code, options);
  parser.parse(second.code);
  assert.equal(classes(second.code).length, 1);
  assert.equal(second.report.modernization.classesConverted, 0);
  assert.deepEqual(observeTrustedProgram(second.code), observeTrustedProgram(first.code));
});

test('class statistics describe successful prototype and static conversions', () => {
  const source = `function Counter(value){this.value=value}Counter.prototype.add=function(delta){return this.value+delta};Counter.make=function(value){return new Counter(value)};globalThis.result=Counter.make(4).add(3);`;
  const { report } = deobfuscate(source, options);
  assert.equal(report.modernization.mode, 'class');
  assert.equal(report.modernization.classesConverted, 1);
  assert.equal(report.modernization.prototypeMethodsConverted, 1);
  assert.equal(report.modernization.staticMethodsConverted, 1);
  assert.ok(Array.isArray(report.modernization.converted));
  assert.ok(Array.isArray(report.modernization.skipped));
  assert.equal(report.modernization.converted.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(report.modernization)), report.modernization);
});

test('unknown inheritance helpers retain writable constructor prototypes', () => {
  const source = `
    function Parent() {}
    Parent.prototype.read = function () { return 1; };
    function Child() {}
    Child.prototype.read = function () { return 2; };
    function inherit(ChildCtor, ParentCtor) {
      ChildCtor.prototype = Object.create(ParentCtor.prototype);
      ChildCtor.prototype.constructor = ChildCtor;
    }
    inherit(Child, Parent);
    globalThis.result = new Child().read();
  `;
  const { code, report } = assertPreserved(source, options);
  assert.equal(classes(code).length, 0);
  for (const name of ['Child', 'Parent']) {
    assert.ok(report.modernization.skipped.some(item => item.name === name && /unknown call|inheritance/.test(item.reason)));
  }
});

test('cross-family deferred references do not hide an early method observation', () => {
  const source = `
    function Outer() {}
    Outer.prototype.read = function () { return new Inner().read(); };
    function Inner() {}
    var before;
    try { before = new Outer().read(); } catch (error) { before = error.name; }
    Inner.prototype.read = function () { return 'installed'; };
    globalThis.result = [before, new Outer().read()];
  `;
  assertPreserved(source, options);
});

test('environment-selected prototype methods retain their original selection and data-field timing', () => {
  for (const mode of ['first', 'second', 'third']) {
    const source = `
      function Word(value) { this.value = value; }
      Word.prototype.read = function () { return this.value; };
      Word.prototype.apply = function (delta) { return this.am(delta); };
      var Alias = Word;
      var mode = ${JSON.stringify(mode)};
      var bits;
      bits = mode === 'first'
        ? (Alias.prototype.am = function (delta) { return this.value + delta; }, 30)
        : mode === 'second'
          ? (Alias.prototype.am = function (delta) { return this.value - delta; }, 26)
          : (Alias.prototype.am = function (delta) { return this.value * delta; }, 28);
      Alias.prototype.DB = bits;
      globalThis.result = [new Alias(8).apply(3), new Alias(8).DB];
    `;
    const { code } = assertPreserved(source, options);
    assert.ok(classes(code).some(node => node.id && node.id.name === 'Word'));
    assert.match(code, /mode === ['"]first['"]/);
  }
});
