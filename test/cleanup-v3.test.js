'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const decoder = require('../src/passes/string-arrays');
const cleanup = require('../src/passes/cleanup-decoders');
const neutralize = require('../src/passes/neutralize-self-defense');

// Parse/transform/assert only. In particular the real-world fixture is never run.
function transform(source, profile = 'readable', passes = [decoder, cleanup, neutralize]) {
  const ast = parser.parse(source, { sourceType: 'unambiguous' });
  const diagnostics = [], context = { options: { profile }, state: new Map(), warn(code, message, details) { diagnostics.push({ code, message, details }); } };
  for (let iteration = 0; iteration < 5; iteration++) {
    let changes = 0;
    for (const pass of passes) {
      traverse(ast, { Program(path) { path.scope.crawl(); path.stop(); } });
      changes += pass.run(ast, context);
    }
    if (!changes) break;
  }
  return { code: generate(ast).code, diagnostics };
}

const family = `
function table(){var entries=['hello','2','1'];table=function(){return entries};return table();}
function decode(i){var entries=table();return entries[i-16];}
`;
const rotation = `(function(t,n){var a=t();while(!![]){try{if(parseInt(decode(16))===n)break;else a.push(a.shift());}catch(e){a.push(a.shift())}}})(table,1);`;

test('readable removes an unused recognized family and reports its global-private assumption', () => {
  const { code, diagnostics } = transform(`${family}${rotation}const alias=decode;globalThis.result=alias(16);`);
  assert.match(code, /result\s*=\s*["']1["']/);
  assert.doesNotMatch(code, /function (table|decode)|const alias|while/);
  const report = diagnostics.find(item => item.code === 'READABLE_DECODER_SCAFFOLD_REMOVED');
  assert.ok(report);
  assert.deepEqual(report.details.decoders, ['decode']);
  assert.match(report.details.assumption, /external scripts/);
});

test('safe keeps top-level helpers and aliases but removes unused private alias reads', () => {
  const { code } = transform(`${family}var publicAlias=decode;function user(){var privateAlias=decode;return 1}globalThis.result=decode(16);`, 'safe');
  assert.match(code, /function decode|publicAlias/);
  assert.doesNotMatch(code, /privateAlias/);
});

test('dynamic calls and unknown decoder escapes keep the family', () => {
  for (const usage of ['globalThis.result=decode(globalThis.index);', 'globalThis.saved=decode;', 'module.exports=decode;', 'export { decode };', 'export const publicAlias=decode;']) {
    const { code } = transform(`${family}${usage}`);
    assert.match(code, /function decode/);
    assert.match(code, /function table/);
  }
});

test('unknown side-effectful providers are preserved', () => {
  const { code } = transform(`function table(){globalThis.count++;return ['hello']}function decode(i){var entries=table();return entries[i]}globalThis.result=decode(0);`);
  assert.match(code, /count\+\+/);
  assert.match(code, /decode\(0\)/);
});

test('a solved rotation with additional startup effects is not deleted', () => {
  const altered = rotation.replace('var a=t();', 'var a=t();globalThis.tick++;');
  const { code, diagnostics } = transform(`${family}${altered}globalThis.result=decode(16);`);
  assert.match(code, /tick\+\+/);
  assert.match(code, /function decode/);
  assert.ok(diagnostics.some(item => item.code === 'DECODER_CLEANUP_PRESERVED_EFFECTS'));
});

const once = `var once=(function(){var first=true;return function(receiver,callback){var wrapped=first?function(){if(callback){var value=callback.apply(receiver,arguments);return callback=null,value}}:function(){};return first=false,wrapped}})();`;
const sourceTrap = `check.toString().search('(((.+)+)+)+$').toString().constructor(check).search('(((.+)+)+)+$')`;

test('readable neutralizes and reports the recognized once-only source-text trap', () => {
  const { code, diagnostics } = transform(`${once}var check=once(this,function(){return ${sourceTrap}});check();`);
  assert.doesNotMatch(code, /\.search\(|\(\(\(\.\+\)/);
  assert.ok(diagnostics.some(item => item.code === 'SOURCE_SELF_DEFENSE_NEUTRALIZED'));
});

test('safe does not disable source-text checks', () => {
  const { code, diagnostics } = transform(`${once}var check=once(this,function(){return ${sourceTrap}});check();`, 'safe');
  assert.match(code, /\.search\(/);
  assert.ok(!diagnostics.some(item => item.code === 'SOURCE_SELF_DEFENSE_NEUTRALIZED'));
});

test('unknown factories, escaped checks and callbacks with business effects are retained', () => {
  for (const source of [
    `var check=external(this,function(){return ${sourceTrap}});check();`,
    `${once}var check=once(this,function(){globalThis.events.push('business');return ${sourceTrap}});check();`,
    `${once}var check=once(this,function(){return ${sourceTrap}});globalThis.saved=check;check();`,
    `${once}var check=once(this,function(){return ${sourceTrap.replaceAll('(((.+)+)+)+$', 'another regex')}});check();`
  ]) {
    const { code, diagnostics } = transform(source);
    assert.match(code, /\.search\(/);
    assert.ok(!diagnostics.some(item => item.code === 'SOURCE_SELF_DEFENSE_NEUTRALIZED'));
  }
});

test('original real-world fixture loses its complete decoder family and source-text trap in readable', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/zhihuishu-2.obfuscated.js'), 'utf8');
  const generic = require('../src/passes').filter(pass => !['cleanup-decoders', 'neutralize-self-defense'].includes(pass.name));
  const { code, diagnostics } = transform(source, 'readable', [...generic, cleanup, neutralize]);
  assert.doesNotMatch(code, /a0_0x5e57|a0_0x1329|\(\(\(\.\+\)\+\)\+\)\+\$/);
  assert.match(code, /aesUtil|rsaUtil/);
  assert.ok(diagnostics.some(item => item.code === 'READABLE_DECODER_SCAFFOLD_REMOVED'));
  assert.ok(diagnostics.some(item => item.code === 'SOURCE_SELF_DEFENSE_NEUTRALIZED'));
});
