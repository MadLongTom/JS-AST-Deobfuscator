'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const normalize = require('../src/passes/normalize-statements');
const { modernizeInheritance } = require('../src/modernize/inheritance');
const { observeTrustedProgram } = require('./helpers');

const helper = `var inheritStatics=function(derived,base){return(inheritStatics=Object.setPrototypeOf||{__proto__:[]}instanceof Array&&function(derived,base){derived.__proto__=base}||function(derived,base){for(var key in base)base.hasOwnProperty(key)&&(derived[key]=base[key])})(derived,base)};`;

function fixture(options = {}) {
  return `${options.helper || helper}
    function Parent(value){this.value=value;${options.parentReturn || ''}}
    Parent.prototype.baseRead=function(){return this.value};
    Parent.kind=function(){return 'parent'};
    var parentVersion=Parent;
    var childVersion;
    var capturedParent;
    ${options.beforeInstall || ''}
    inheritStatics(${options.childArgument || 'childVersion=Child'},parentVersion=capturedParent=parentVersion);
    childVersion.prototype=null===parentVersion?Object.create(parentVersion):(Bridge.prototype=parentVersion.prototype,new Bridge());
    Child.prototype.read=function(){return this.value+this.extra};
    ${options.betweenMethods || ''}
    Child.from=function(value){return new Child(value)};
    var PublicChild=Child;
    function Bridge(){this.constructor=childVersion}
    ${Object.hasOwn(options, 'constructor') ? options.constructor : 'function Child(value){var self=capturedParent.call(this,value)||this;self.extra=1;return self}'}
    ${options.afterInstall || ''}
    ${options.usage || "globalThis.result=[new PublicChild(5).read(),Child.kind(),new Child(1).constructor===Child,Object.getPrototypeOf(Child)===Parent,Object.getPrototypeOf(Child.prototype)===Parent.prototype];"}
  `;
}

function transform(source) {
  const ast = parser.parse(source), diagnostics = [];
  for (let index = 0; index < 8 && normalize.run(ast); index++) { /* Expose canonical statement installations. */ }
  traverse(ast, { Program(path) { path.scope.crawl(); path.stop(); } });
  const report = modernizeInheritance(ast, { options: { modernize: 'class' }, warn(code, message, details) { diagnostics.push({ code, message, details }); } });
  const code = generate(ast).code;
  parser.parse(code);
  return { code, report, diagnostics };
}

function preserve(source) {
  const result = transform(source);
  // Only hand-written trusted programs from this file are executed here.
  assert.deepEqual(observeTrustedProgram(result.code), observeTrustedProgram(source));
  return result;
}

test('canonical bridge inheritance becomes a complete parent and derived class', () => {
  const { code, report, diagnostics } = preserve(fixture());
  assert.equal(report.changes, 2);
  assert.deepEqual(report.converted.map(record => record.name).sort(), ['Child', 'Parent']);
  assert.ok(report.converted.every(record => record.engine === 'babel-inheritance'));
  assert.match(code, /class Child extends Parent/);
  assert.match(code, /super\(value\)/);
  assert.doesNotMatch(code, /function Bridge|inheritStatics|childVersion|capturedParent/);
  assert.ok(diagnostics.some(item => item.code === 'CLASS_INHERITANCE_ASSUMPTIONS'));
});

test('constructor return-this and captured super aliases retain behavior', () => {
  const { report } = preserve(fixture({ parentReturn: 'return this;', constructor: 'function Child(value){var self=capturedParent.call(this,value)||this;self.extra=1;self.closure=function(){return self.value};return self}', usage: 'var child=new Child(7);globalThis.result=[child.read(),child.closure()];' }));
  assert.equal(report.converted.length, 2);
});

test('a later rewritten parent alias stays live while the captured super alias stays stable', () => {
  const { code, report } = preserve(fixture({ afterInstall: 'function Other(){}parentVersion=Other;', usage: 'globalThis.result=[new Child(5).read(),parentVersion===Other];' }));
  assert.equal(report.converted.length, 2);
  assert.match(code, /parentVersion\s*=\s*Other/);
  assert.match(code, /var parentVersion\s*=\s*Parent/);
});

for (const [name, changes] of [
  ['truthy primitive parent return', { parentReturn: 'return 1;' }],
  ['object-valued parent return', { parentReturn: 'return {value:8};' }],
  ['this in derived parameter defaults', { constructor: 'function Child(value=this){var self=capturedParent.call(this,value)||this;self.extra=1;return self}', usage: 'globalThis.result=new Child().value instanceof Child;' }],
  ['this in super arguments', { constructor: 'function Child(value){var self=capturedParent.call(this,this.value)||this;self.extra=1;return self}' }],
  ['this before the super capture', { constructor: 'function Child(value){this.extra=4;var self=capturedParent.call(this,value)||this;return self}' }],
  ['reassigned root constructor', { afterInstall: 'Parent=function(value){this.value=9};' }],
  ['reassigned captured parent alias', { afterInstall: 'function Other(value){this.value=value+10}capturedParent=Other;' }],
  ['reassigned bridge constructor', { beforeInstall: 'globalThis.side=0;Bridge=function(){globalThis.side++};', usage: 'globalThis.result=globalThis.side;' }],
  ['ordinary constructor call through a sequence', { usage: 'globalThis.result=typeof (0,Child)();' }],
  ['method construction through a conditional', { betweenMethods: 'Child.prototype.Factory=function(){this.value=7};', usage: 'function Other(){}globalThis.result=new (true?Child.prototype.Factory:Other)().value;' }],
  ['static method construction', { betweenMethods: 'Child.Factory=function(){this.value=7};', usage: 'globalThis.result=new Child.Factory().value;' }],
  ['Reflect.construct on a method', { betweenMethods: 'Child.prototype.Factory=function(){this.value=7};', usage: 'globalThis.result=Reflect.construct(Child.prototype.Factory,[]).value;' }],
  ['a method observation between installations', { betweenMethods: 'globalThis.trace=typeof Child.from;' }],
  ['an early child prototype observation', { beforeInstall: 'globalThis.trace=typeof Child.prototype.read;' }],
  ['a child alias captured before the class anchor', { beforeInstall: 'var Saved=Child;', usage: 'globalThis.result=new Saved(5).read();' }],
  ['additional helper argument side effects', { beforeInstall: 'globalThis.side=0;', childArgument: '(globalThis.side++,childVersion=Child)', usage: 'globalThis.result=globalThis.side;' }],
  ['assignment to a const helper temporary', { beforeInstall: 'const Fixed=null;', childArgument: 'childVersion=Fixed=Child' }],
  ['assignment to an uninitialized lexical temporary', { childArgument: 'childVersion=Later=Child', afterInstall: 'let Later;' }],
  ['alias changes inside an invoked closure', { beforeInstall: 'function Other(value){this.value=value+20}function mutate(){parentVersion=Other}mutate();' }],
]) {
  test(`non-canonical or unsafe inherited family is retained: ${name}`, () => {
    const { code, report } = preserve(fixture(changes));
    assert.equal(report.converted.length, 0);
    assert.doesNotMatch(code, /class Child extends/);
    assert.ok(report.skipped.length > 0);
  });
}

test('unknown inheritance helpers with side effects are not removed', () => {
  const modified = helper.replace('return(', 'globalThis.side++;return(');
  const { code, report } = preserve(fixture({ helper: `globalThis.side=0;${modified}`, usage: 'globalThis.result=globalThis.side;' }));
  assert.equal(report.converted.length, 0);
  assert.match(code, /side\+\+/);
});

test('a const self-specializing helper retains its assignment error', () => {
  const source = fixture({ helper: helper.replace('var inheritStatics', 'const inheritStatics') });
  const result = preserve(source);
  assert.equal(result.report.converted.length, 0);
});

test('observed helper specialization is preserved', () => {
  const source = fixture({ usage: 'globalThis.result=inheritStatics===Object.setPrototypeOf;' });
  const result = preserve(source);
  assert.equal(result.report.converted.length, 0);
});

test('ordinary Parent.call code without the canonical bridge is not reinterpreted as extends', () => {
  const source = `function Parent(value){this.value=value}function Child(value){var self=Parent.call(this,value)||this;return self}Child.prototype.read=function(){return this.value};globalThis.result=new Child(3).read();`;
  assert.equal(preserve(source).report.converted.length, 0);
});

test('shadowed Object inheritance builtins are not treated as the standard helper', () => {
  const source = `(function(Object){${fixture()}})({setPrototypeOf:function(){},create:function(){return {}}});`;
  assert.equal(preserve(source).report.converted.length, 0);
});

test('the original RSA fixture is only parsed and its complete inheritance family is collected', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/zhihuishu-2.obfuscated.js'), 'utf8');
  const { code, report } = transform(source); // Never execute downloaded code.
  assert.equal(report.converted.length, 2);
  assert.match(code, /class lt extends nt/);
  const base = report.converted.find(record => record.name === 'nt');
  const derived = report.converted.find(record => record.name === 'lt');
  assert.equal(base.methods, 11);
  assert.equal(derived.methods, 8);
  assert.equal(derived.staticMethods, 3);
  assert.doesNotMatch(code, /nt\.prototype\.[\w$]+\s*=|lt\.prototype\.[\w$]+\s*=/);
});
