'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { jsonIntrinsicHazard } = require('../src/analysis/intrinsic-hazards');
const { observeTrustedProgram } = require('./helpers');

function hazard(source, resolver) {
  let answer;
  traverse(parser.parse(source, { sourceType: 'script' }), { Program(path) { answer = jsonIntrinsicHazard(path, resolver); path.stop(); } });
  return answer;
}

for (const [name, source] of [
  ['direct RegExp mutation', 'RegExp.prototype.test=evil'],
  ['a constant prototype alias', 'const p=RegExp.prototype;p.test=evil'],
  ['multiple constant aliases', 'const p=RegExp.prototype;const q=p;q.exec=evil'],
  ['a global object alias', 'const w=window;const R=w.RegExp;R.prototype.test=evil'],
  ['a globalThis-qualified path', 'globalThis.RegExp.prototype.test=evil'],
  ['a self-qualified path', 'self.String.prototype.replace=evil'],
  ['global constructor replacement', 'const w=globalThis;w.String=evil'],
  ['a borrowed defineProperty', 'const define=Object.defineProperty;define(RegExp.prototype,"test",{value:evil})'],
  ['destructured defineProperty', 'const {defineProperty:define}=Object;define(RegExp.prototype,"test",{value:evil})'],
  ['destructured prototype', 'const {prototype:p}=String;p.slice=evil'],
  ['a mutator call', 'Object.defineProperty.call(Object,RegExp.prototype,"test",{value:evil})'],
  ['a mutator apply', 'Object.defineProperty.apply(Object,[String.prototype,"replace",{value:evil}])'],
  ['a partially bound mutator', 'const define=Object.defineProperty.bind(Object,RegExp.prototype);define("test",{value:evil})'],
  ['a bound mutator used through call', 'const define=Object.defineProperty.bind(Object,String.prototype);define.call(null,"replace",{value:evil})'],
  ['a protected Number method', 'const p=Number.prototype;p.toString=evil'],
  ['prototype chain mutation', 'const p=String.prototype;Object.setPrototypeOf(p,evil)'],
  ['direct prototype chain mutation', 'String.prototype.__proto__=evil'],
  ['unknown computed prototype mutation', 'String.prototype[key]=evil'],
  ['unknown computed constructor path', 'String[key].replace=evil'],
  ['passing a protected prototype to an unknown function', 'patch(String.prototype)'],
  ['passing a constructor to an unknown function', 'patch(RegExp)'],
  ['returning a protected prototype', 'function get(){return RegExp.prototype}'],
  ['storing a protected prototype', 'const holder={p:RegExp.prototype};holder.p.test=evil'],
  ['a mutable prototype alias', 'let p=RegExp.prototype;p=other;p.test=evil'],
  ['a prototype obtained from a RegExp literal', 'Object.getPrototypeOf(/x/).test=evil'],
  ['a prototype obtained from a primitive', 'Object.getPrototypeOf("").replace=evil'],
  ['a mutator return alias', 'const p=Object.assign(String.prototype,{trim:fn});p.replace=evil'],
  ['Reflect.set with a protected receiver', 'Reflect.set({},"test",evil,RegExp.prototype)'],
  ['destructuring assignment mutation', '({x:RegExp.prototype.test}=value)'],
  ['loop assignment mutation', 'for(RegExp.prototype.test of values){}'],
  ['a String accessor outside the protected keys', 'Object.defineProperty(String.prototype,"trim",{get:function(){this.replace=evil}})'],
  ['an unknown descriptor', 'Object.defineProperty(String.prototype,"trim",descriptor)'],
  ['a mutator replacement before an apparently harmless call', 'Object.defineProperty=evil;Object.defineProperty(String.prototype,"trim",{value:fn})'],
  ['invoking an unknown prototype method with the prototype receiver', 'String.prototype.trim=function(){this.replace=evil};String.prototype.trim()'],
  ['escaping a partially bound mutator', 'const define=Object.defineProperty.bind(Object,String.prototype);leak(define)'],
  ['an unknown global write returning a value', 'window[key]=function(){return input}'],
  ['an unknown global write of an arbitrary external value', 'window[key]=external'],
  ['a prototype write even when its value is a callback', 'String.prototype[key]=function(){}'],
  ['a mutation facade potentially overwritten by a dynamic callback', 'window[key]=function(){};Object.defineProperty(String.prototype,"trim",{value:fn})'],
]) test(`JSON intrinsic hazards reject ${name}`, () => assert.equal(hazard(source), true));

for (const [name, source] of [
  ['no intrinsic use', 'const local=7;result=local'],
  ['a shadowed RegExp', 'function fn(RegExp){RegExp.prototype.test=evil}'],
  ['a shadowed global object', 'function fn(window){window.String.prototype.replace=evil}'],
  ['String trim polyfill', 'String.prototype.trim||(String.prototype.trim=function(){return this.replace(/^\s+|\s+$/g,"")})'],
  ['String toJSON data property', 'String.prototype.toJSON=fn'],
  ['Number toJSON data property', 'Number.prototype.toJSON=fn'],
  ['an unrelated String static field', 'String.extra=fn'],
  ['a known unrelated alias property', 'const p=String.prototype;p.toJSON=fn'],
  ['a known safe Object.defineProperty', 'Object.defineProperty(String.prototype,"trim",{value:fn,writable:true})'],
  ['a borrowed safe Object.defineProperty', 'const define=Object.defineProperty;define(String.prototype,"trim",{value:fn})'],
  ['an apply of a safe Object.defineProperty', 'Object.defineProperty.apply(Object,[String.prototype,"trim",{value:fn}])'],
  ['a bound safe Object.defineProperty', 'const define=Object.defineProperty.bind(Object,String.prototype);define("trim",{value:fn})'],
  ['known safe defineProperties', 'Object.defineProperties(String.prototype,{trim:{value:fn},toJSON:{value:fn}})'],
  ['known safe Object.assign', 'Object.assign(String.prototype,{trim:fn,toJSON:fn})'],
  ['a protected constructor alias used only for primitive conversion', 'const S=String;const text=S(input)'],
  ['a native prototype method read', 'const test=RegExp.prototype.test;test.call(/x/,"x")'],
  ['a dynamic JSONP callback returning no value', 'window[callbackName]=function(data){consume(data)}'],
  ['a constant cleanup callback returning no value', 'function empty(){}window[callbackName]=empty'],
  ['clearing a dynamic global callback', 'window[callbackName]=null'],
]) test(`JSON intrinsic hazards allow ${name}`, () => assert.equal(hazard(source), false));

test('JSON intrinsic hazards use an explicit static resolver for opaque properties', () => {
  const source = 'String[decode(1)][decode(2)]=fn;Number[decode(1)][decode(3)]=fn';
  assert.equal(hazard(source), true);
  const resolver = path => path.isCallExpression() && path.get('callee').isIdentifier({ name: 'decode' }) ? ({ 1: 'prototype', 2: 'trim', 3: 'toJSON' })[path.node.arguments[0].value] : undefined;
  assert.equal(hazard(source, resolver), false);
  assert.equal(hazard(source, path => resolver(path) === 'trim' ? 'replace' : resolver(path)), true);
});

test('JSON intrinsic hazards optionally report source paths and reasons', () => {
  const reports = [];
  traverse(parser.parse('RegExp.prototype.test=evil'), { Program(path) {
    assert.equal(jsonIntrinsicHazard(path, undefined, { onHazard: (at, reason) => reports.push([at.node.type, reason]) }), true);
    path.stop();
  } });
  assert.ok(reports.some(([type, reason]) => type === 'MemberExpression' && reason === 'protected-write'));
});

test('JSON intrinsic hazards prove a dynamic namespace cannot replace a protected global', () => {
  assert.equal(hazard('window["callback_"+input]=external'), false);
  assert.equal(hazard('const key="callback_"+input;window[key]=external'), false);
  assert.equal(hazard('window[input+"_callback"]=external'), false);
  assert.equal(hazard('window["Str"+input]=external'), true);
  assert.equal(hazard('window[input+"String"]=external'), true);
  assert.equal(hazard('String.prototype["callback_"+input]=external'), true);
});

test('JSON intrinsic hazards bound string key computation and protect its extra native dependency', () => {
  const safe = 'const raw="Some_Key";const name=raw.replace(/[^a-zA-Z0-9$]/g,"").toLowerCase();window[name]=external';
  assert.equal(hazard(safe), false);
  assert.equal(hazard('String.prototype.toLowerCase=evil;'+safe), true);
  assert.equal(hazard('Object.defineProperty(String.prototype,"toLowerCase",{value:evil});'+safe), true);
  assert.equal(hazard('const name=input.toLowerCase();window[name]=external'), true);
});

// Only these trusted synthetic programs are executed. The vendor SDK remains
// a parse-only fixture throughout the analysis and transformation test suite.
const parserProgram = String.raw`
(function(){
  var secret=7;
  function parse(text){
    if(text=String(text),/^[\],:{}\s]*$/.test(text.replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g,'@').replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g,']').replace(/(?:^|:|,)(?:\s*\[)+/g,'')))return eval('('+text+')');
    throw new SyntaxError('JSON.parse');
  }
  function install(name){globalThis[name]=CALLBACK}
  install('String');
  var exception=null;
  try{parse('secret=9')}catch(error){exception=error.name}
  globalThis.result={secret:secret,exception:exception};
})();`;

test('JSON intrinsic hazards permit only no-value callbacks because coercion then fails before eval', () => {
  const source = parserProgram.replace('CALLBACK', 'function(){}');
  assert.equal(hazard(source), false);
  assert.equal(observeTrustedProgram(source).result, JSON.stringify({ secret: 7, exception: 'TypeError' }));
});

test('JSON intrinsic hazards reject a returning callback that can fake validation and mutate a lexical binding', () => {
  const source = parserProgram.replace('CALLBACK', 'function(){return {replace:function(){return ""},toString:function(){return "secret=9"}}}');
  assert.equal(hazard(source), true);
  assert.equal(observeTrustedProgram(source).result, JSON.stringify({ secret: 9, exception: null }));
});
