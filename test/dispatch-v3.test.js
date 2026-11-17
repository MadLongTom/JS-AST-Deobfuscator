'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deobfuscate } = require('../src');
const { assertPreserved } = require('./helpers');
const options = { passes: ['inline-objects', 'inline-wrappers', 'constant-fold', 'dead-code'], maxIterations: 10 };

test('dispatch: immutable table reads cross closures created after initialization', () => {
  const { code } = assertPreserved(`(function(){const table={text:'ready',add:function(a,b){return a+b}};const api=function(x){return table.add(x,table.text.length)};globalThis.result=api(2)})()`, options);
  assert.doesNotMatch(code, /table\.|const table/);
});

test('dispatch: hoisted private function is safe when every exposure follows initialization', () => {
  const { code } = assertPreserved(`(function(){function read(){return table.value}const table={value:7};globalThis.result=read()})()`, options);
  assert.match(code, /return 7|result = 7/);
  assert.doesNotMatch(code, /table\.value/);
});

test('dispatch: synchronous callback created after initialization is safe', () => {
  const { code } = assertPreserved(`(function(){const table={type:'json',call:function(f,x){return f(x)}};function run(cb){cb()}run(function(){table.call(function(x){globalThis.result=x},table.type)})})()`, options);
  assert.doesNotMatch(code, /table\.|const table/);
});

test('dispatch: empty object, contiguous assignments and stable alias chains are resolved', () => {
  const { code } = assertPreserved(`(function(){var table={};table.add=function(a,b){return a+b},table.value=4;var alias=table;var second=alias;globalThis.result=second.add(3,second.value)})()`, options);
  assert.match(code, /result = 7/);
  assert.doesNotMatch(code, /table|alias|second/);
});

test('dispatch: wrappers referring to their own private table simplify iteratively', () => {
  const { code } = assertPreserved(`(function(){const table={add:function(a,b){return a+b},forward:function(a,b){return table.add(a,b)}};globalThis.result=table.forward(3,4)})()`, options);
  assert.match(code, /result = 7/);
  assert.doesNotMatch(code, /table\./);
});

test('dispatch: an unrelated initializer side effect survives property expansion', () => {
  const { code } = assertPreserved(`globalThis.trace=[];(function(){const table={value:7,other:trace.push('init')};globalThis.result=table.value})()`, options);
  assert.match(code, /trace\.push\(['"]init['"]\)/);
  assert.match(code, /result = 7/);
});

for (const [label, source] of [
  ['early hoisted closure', `(function(){function read(){return table.value}globalThis.result=read();var table={value:7}})()`],
  ['callback registered before initialization', `(function(){const read=()=>table.value;globalThis.result=read();const table={value:7}})()`],
  ['table-owned closure before alias initialization', `(function(){const table={read:function(){return alias.value},value:7};globalThis.result=table.read();const alias=table})()`],
  ['mutation through alias', `(function(){const table={value:7};const alias=table;alias.value=9;globalThis.result=table.value})()`],
  ['object escape', `(function(){const table={value:7};globalThis.saved=table;saved.value=9;globalThis.result=table.value})()`],
  ['getter property', `(function(){const table={get value(){return 7}};globalThis.result=table.value})()`],
  ['receiver mutation', `(function(){const table={value:7,change:function(){this.value=9}};table.change();globalThis.result=table.value})()`],
  ['unknown receiver method', `(function(){function change(){this.value=9}const table={value:7,change:change};table.change();globalThis.result=table.value})()`],
  ['API object escape', `function make(){const table={value:7,read:function(){return this.value}};return table}globalThis.result=make().read()`],
]) test(`dispatch: ${label} is retained conservatively`, () => {
  const { code } = assertPreserved(source, options);
  assert.match(code, /table/);
});

test('dispatch: exported hoisted readers do not justify module initialization dominance', () => {
  const { code } = deobfuscate('export function read(){return table.value}const table={value:7};', { ...options, sourceType: 'module' });
  assert.match(code, /table\.value/);
});

test('dispatch: staged assignment observes an inherited setter', () => {
  const { code } = assertPreserved(`globalThis.trace=[];Object.defineProperty(Object.prototype,'value',{set(x){trace.push(x)},get(){return 9},configurable:true});(function(){const table={};table.value=7;globalThis.result=table.value})()`, options);
  assert.match(code, /table\.value/);
});

test('wrappers: binary argument evaluation and coercion retain their order', () => {
  const { code } = assertPreserved(`globalThis.trace=[];(function(){function add(a,b){return a+b}function arg(n){trace.push('arg'+n);return {valueOf(){trace.push('coerce'+n);return n}}}globalThis.result=add(arg(1),arg(2))})()`, options);
  assert.match(code, /arg\(1\) \+ arg\(2\)/);
});

for (const [label, body, args] of [
  ['repeated argument', 'a+a', `next('a'),next('b')`],
  ['reordered argument', 'b-a', `next('a'),next('b')`],
  ['eager logical right argument', 'a&&b', `next('a',0),next('b',2)`],
  ['eager conditional arms', 'a?b:3', `next('a',0),next('b',2)`],
  ['unused extra arguments', 'a', `next('a'),next('b'),next('c')`],
  ['missing arguments', 'a+b', `next('a')`],
]) test(`wrappers: ${label} preserves all evaluations`, () => {
  assertPreserved(`globalThis.trace=[];(function(){function wrap(a,b){return ${body}}function next(s,n){trace.push(s);return n===undefined?trace.length:n}globalThis.result=wrap(${args})})()`, options);
});

test('wrappers: nested coercion waits for every original argument', () => {
  assertPreserved(`globalThis.trace=[];(function(){function wrap(a,b,c){return a+b+c}const a={valueOf(){trace.push('coerce');return 1}};function next(s){trace.push(s);return 2}globalThis.result=wrap(a,next('b'),next('c'))})()`, options);
});

test('wrappers: call proxy does not capture a method receiver', () => {
  const { code } = assertPreserved(`(function(){const table={call:function(f,a){return f(a)}};const obj={method:function(){'use strict';return this===undefined}};globalThis.result=table.call(obj.method,2)})()`, options);
  assert.match(code, /0, obj\.method/);
});

test('wrappers: call proxy retains indirect eval', () => {
  const { code } = assertPreserved(`(function(){const secret=42;const table={call:function(f,a){return f(a)}};globalThis.result=table.call(eval,'typeof secret')})()`, options);
  assert.match(code, /0, eval/);
});

test('wrappers: repeated call-proxy parameters evaluate argument getters once', () => {
  assertPreserved(`globalThis.trace=[];(function(){function proxy(a,f){return f(a,a)}const obj={get x(){trace.push('get');return 2}};globalThis.result=proxy(obj.x,function(a,b){return a+b})})()`, options);
});

test('wrappers: global alias reads keep their timing after all arguments', () => {
  assertPreserved(`globalThis.trace=[];Object.defineProperty(globalThis,'sourceAlias',{get(){trace.push('alias');return 1}});(function(){function wrap(a,b){var unused=sourceAlias;return a+b}function next(n){trace.push(n);return n}globalThis.result=wrap(next(1),next(2))})()`, options);
});

test('wrappers: a moved alias initializer cannot capture a shadowing binding', () => {
  const { code } = assertPreserved(`(function(){let sourceAlias=1;function wrap(a,b){var unused=sourceAlias;return a+b}function inner(sourceAlias){return wrap(1,2)}globalThis.result=inner(9)})()`, { passes: ['inline-wrappers'] });
  assert.match(code, /wrap\(1, 2\)/);
});

test('wrappers: a failed alias read still occurs after side-effectful arguments', () => {
  assertPreserved(`globalThis.trace=[];(function(){function wrap(a,b){var unused=missingAlias;return a+b}function next(n){trace.push(n);return n}globalThis.result=wrap(next(1),next(2))})()`, options);
});

test('wrappers: identity remains a value in typeof, delete and call contexts', () => {
  for (const source of [
    `(function(){function id(a){return a}globalThis.result=typeof id(missing)})()`,
    `(function(){function id(a){return a}const obj={x:1};globalThis.result=[delete id(obj.x),obj.x]})()`,
    `(function(){function id(a){return a}const obj={m:function(){'use strict';return this===undefined}};globalThis.result=id(obj.m)()})()`,
  ]) assertPreserved(source, options);
});

test('wrappers: body temporaries do not change formal parameters or arguments', () => {
  const { code } = assertPreserved(`(function(){function wrap(a,b){return a+a}var x=wrap(1,2);globalThis.result=[x,arguments.length,arguments.callee.length]})()`, { passes: ['inline-wrappers'] });
  assert.match(code, /^\(function \(\)/);
});

test('wrappers: default parameter expressions use isolated temporary scopes', () => {
  assertPreserved(`(function(){function dup(a){return a+a}function f(value=dup(2)){return value}globalThis.result=f()})()`, options);
});

test('wrappers: script globals and global writes remain visible', () => {
  const { code } = assertPreserved(`function wrap(a,b){return a+b}globalThis.wrap=function(){return 9};globalThis.result=wrap(1,2)`, options);
  assert.match(code, /wrap\(1, 2\)/);
});

test('wrappers: captured expression names are not substituted', () => {
  const { code } = assertPreserved(`(function(){const captured=4;function wrap(a){return captured+a}globalThis.result=wrap(2)})()`, { passes: ['inline-wrappers'] });
  assert.match(code, /wrap\(2\)/);
});

test('wrappers: a parameter named eval is not changed into an indirect call', () => {
  const { code } = assertPreserved(`(function(){function wrap(eval,code){return eval(code)}globalThis.result=wrap(eval,'typeof code')})()`, options);
  assert.match(code, /wrap\(eval/);
});
