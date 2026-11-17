'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertPreserved } = require('./helpers');
const flow = { passes: ['control-flow'] };
const normalize = { passes: ['normalize-statements'] };

test('dispatch initializers inside an enclosing loop are still local dominating writes', () => {
  const source = `globalThis.trace=[];(function(){for(var round=0;round<2;round++){var order='1|0'.split('|');var index=0;while(true){switch(order[index++]){case '0':trace.push(round+'a');continue;case '1':trace.push(round+'b');continue;}break;}}globalThis.result=trace})()`;
  const { code } = assertPreserved(source, flow);
  assert.doesNotMatch(code, /\bwhile\s*\(|\bswitch\s*\(/);
});

test('terminal returns flatten while declarations in discarded later cases still hoist', () => {
  const source = `globalThis.trace=[];(function(){function run(){try{trace.push(hidden)}catch(e){trace.push(e.name)}var order='0|1'.split('|');var index=0;while(true){switch(order[index++]){case '0':return 4;case '1':var hidden=7;continue;}break;}}globalThis.result=run()})()`;
  const { code } = assertPreserved(source, flow);
  assert.doesNotMatch(code, /\bswitch\s*\(/);
});

test('terminal throws retain their effects and the following function catch', () => {
  const source = `globalThis.trace=[];(function(){function run(){var order='0|1'.split('|');var index=0;while(true){switch(order[index++]){case '0':trace.push('throw');throw new TypeError('stop');case '1':trace.push('never');continue;}break;}}try{run()}catch(e){globalThis.result=e.name}})()`;
  const { code } = assertPreserved(source, flow);
  assert.doesNotMatch(code, /\bswitch\s*\(/);
});

test('ordinary split and String.fromCharCode reads do not block a dispatcher', () => {
  const source = `globalThis.trace=[];(function(){var text='x.y';trace.push(text.split('.').length);trace.push(String.fromCharCode(65));var order='1|0'.split('|');var index=0;while(true){switch(order[index++]){case '0':trace.push('a');continue;case '1':trace.push('b');continue;}break;}globalThis.result=trace})()`;
  const { code } = assertPreserved(source, flow);
  assert.doesNotMatch(code, /\bswitch\s*\(/);
});

test('prototype escape through an alias keeps the intrinsic split uncertain', () => {
  const source = `globalThis.trace=[];(function(){var proto=String.prototype;proto.split=function(){return ['1','0']};var order='0|1'.split('|');var index=0;while(true){switch(order[index++]){case '0':trace.push('a');continue;case '1':trace.push('b');continue;}break;}globalThis.result=trace})()`;
  const { code } = assertPreserved(source, flow);
  assert.match(code, /\bswitch\s*\(/);
});

test('normalizing sequence initializers retains lexical TDZ and var initialization timing', () => {
  for (const source of [
    `globalThis.trace=[];(function(){var x=(trace.push(x),3);globalThis.result=[x,trace]})()`,
    `(function(){try{let x=(x,3)}catch(e){globalThis.result=e.name}})()`,
    `globalThis.trace=[];(function(){let x=(trace.push('first'),2),y=(trace.push(x),3);globalThis.result=[x,y,trace]})()`,
  ]) assertPreserved(source, normalize);
});

test('initializer lifting makes a discarded short-circuit assignment explicit', () => {
  const { code } = assertPreserved(`(function(){var url='old';var key=(true&&(url='new'),7);globalThis.result=[url,key]})()`, normalize);
  assert.match(code, /if\s*\(true\)/);
  assert.doesNotMatch(code, /var key = \(/);
});

test('flattening a declaration-free block cannot introduce a strict directive', () => {
  const { code } = assertPreserved(`function read(){{'use strict';}return this===undefined}globalThis.result=read()`, normalize);
  assert.match(code, /\(['"]use strict['"]\)/);
});

test('blocks containing lexical declarations retain their scope', () => {
  assertPreserved(`(function(){let value=1;{let value=2;globalThis.trace=[value]}globalThis.result=value})()`, normalize);
});

test('readable dispatcher cleanup does not remove externally observed indices', () => {
  assertPreserved(`(function(){var order='0'.split('|');var index=0;while(true){switch(order[index++]){case '0':continue;}break;}globalThis.result=index})()`, { ...flow, profile: 'readable' });
});
