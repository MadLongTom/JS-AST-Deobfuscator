'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deobfuscate } = require('../src');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { createStaticResolver } = require('../src/passes/substituted-hex');

const alphabet = '2izvR3Ydkgw605lf';
const encode = value => Buffer.from(value, 'utf8').toString('hex').split('').map(digit => alphabet[parseInt(digit, 16)]).join('');
const options = { passes: ['decode-substituted-hex'], maxIterations: 2 };
const method = `function(input) {
  if (null == input || void 0 == input) return input;
  if (0 != input.length % 2) throw Error('1100');
  for (var output = [], cursor = 0; cursor < input.length; cursor++) {
    if (0 == cursor % 2) { output.push('%'); }
    for (var digits = symbols, index = 0; index < digits.length; index++) if (input.charAt(cursor) == digits[index]) {
      output.push(index.toString(16)); break;
    }
  }
  return decodeURIComponent(output.join(''));
}`;
function fixture(body = '') {
  return `function Unpack(){var symbols=${JSON.stringify(alphabet)}.split('');this.m=${method};this.f=${method};}
    var decode=new Unpack().m;${body}`;
}
const result = value => `result=decode(${JSON.stringify(encode(value))});`;

// These fixture strings and vendor snapshots are only parsed. No source helper
// or downloaded SDK is evaluated to obtain the expected decoded literals.
test('canonical substituted-hex helpers decode Unicode, ASCII and empty literals', () => {
  for (const value of ['hello', '智慧树', '', 'key test']) {
    const transformed = deobfuscate(fixture(result(value)), options);
    assert.ok(transformed.code.includes(`result = ${JSON.stringify(value)};`));
    assert.equal(transformed.report.diagnostics.length, 0);
  }
});

test('constructor, instance and method aliases remain binding aware', () => {
  const input = fixture().replace('var decode=new Unpack().m;', '') +
    `var Factory=Unpack;var instance=new Factory();var decode=instance.f;var alias=decode;
     (function(){result=alias(${JSON.stringify(encode('hello'))});})();`;
  const transformed = deobfuscate(input, options);
  assert.match(transformed.code, /result\s*=\s*"hello"/);
});

test('instance method calls and normalized schemas are recognized', () => {
  const input = fixture().replace('var decode=new Unpack().m;', '') +
    `result=new Unpack().f(${JSON.stringify(encode('hello'))});`;
  const transformed = deobfuscate(input, { ...options, passes: ['normalize-literals', 'normalize-statements', 'decode-substituted-hex'] });
  assert.match(transformed.code, /result\s*=\s*"hello"/);
});

test('dynamic input and shadowed helper bindings are retained', () => {
  const transformed = deobfuscate(fixture(`function nested(decode){return decode('zz')} result=decode(globalThis.input);`), options);
  assert.match(transformed.code, /decode\(globalThis\.input\)/);
  assert.match(transformed.code, /return decode\(["']zz["']\)/);
});

test('unknown escapes, method reassignment and constructor calls are preserved', () => {
  for (const effect of ['globalThis.leak=decode;', 'globalThis.leak=Unpack;', 'Unpack.prototype.m=evil;',
    'decode=evil;', 'Unpack();']) {
    const transformed = deobfuscate(fixture(effect + result('hello')), options);
    assert.match(transformed.code, /result\s*=\s*decode\(/);
  }
  const instance = fixture().replace('var decode=new Unpack().m;', 'var instance=new Unpack();var decode=instance.m;instance.m=evil;');
  assert.match(deobfuscate(instance + result('hello'), options).code, /result\s*=\s*decode\(/);
});

test('constructor arguments and extra method arguments cannot lose effects', () => {
  for (const input of [fixture(result('hello')).replace('new Unpack()', 'new Unpack(effect())'),
    fixture(`result=decode(${JSON.stringify(encode('hello'))},effect());`)]) {
    const transformed = deobfuscate(input, options);
    assert.match(transformed.code, /effect\(\)/);
    assert.match(transformed.code, /result\s*=\s*decode\(/);
  }
});

test('additional constructor effects and modified helper returns are rejected', () => {
  for (const changed of [
    fixture(result('hello')).replace('this.m=', 'globalThis.count++;this.m='),
    fixture(result('hello')).replaceAll("return decodeURIComponent(output.join(''));", "return decodeURIComponent(output.join(''))+'!';"),
    fixture(result('hello')).replaceAll("output.push('%');", "globalThis.count++;output.push('%');"),
  ]) assert.match(deobfuscate(changed, options).code, /result\s*=\s*decode\(/);
});

test('intrinsic mutation, borrowed setters and prototype escapes block decoding', () => {
  for (const effect of [
    'String.prototype.charAt=evil;', 'Array.prototype.push=evil;',
    "var setter=Object.defineProperty;setter(Array.prototype,'join',{value:evil});",
    "var setter=Object.defineProperty;setter.call(null,Array.prototype,'join',{value:evil});",
    "var setter=Object.defineProperty;setter.apply(null,[Array.prototype,'join',{value:evil}]);",
    'var root=globalThis;root.String.prototype.split=evil;', 'consume(String.prototype);',
  ]) {
    const transformed = deobfuscate(fixture(effect + result('hello')), options);
    assert.match(transformed.code, /result\s*=\s*decode\(/);
    assert.ok(transformed.report.diagnostics.some(item => item.code === 'UNSUPPORTED_SUBSTITUTED_HEX_INTRINSIC'));
  }
  assert.match(deobfuscate(fixture('String.prototype.trim=evil;' + result('hello')), options).code, /result\s*=\s*"hello"/);
});

test('unknown eval blocks visible families, unrelated eval does not', () => {
  assert.match(deobfuscate(fixture('function dynamic(code){eval(code)}' + result('hello')), options).code, /result\s*=\s*decode\(/);
  const unrelated = `function dynamic(code){eval(code)} (function(){${fixture(result('hello'))}})();`;
  assert.match(deobfuscate(unrelated, options).code, /result\s*=\s*"hello"/);
});

test('conditional aliases and early closure reads retain initialization behavior', () => {
  const conditional = fixture(result('hello')).replace('var decode=new Unpack().m;', 'if(false){var decode=new Unpack().m;}');
  assert.match(deobfuscate(conditional, options).code, /result\s*=\s*decode\(/);
  const early = fixture().replace('var decode=new Unpack().m;', '') +
    `read();var decode=new Unpack().m;function read(){result=decode(${JSON.stringify(encode('hello'))});}`;
  assert.match(deobfuscate(early, options).code, /result\s*=\s*decode\(/);
});

test('malformed literal and bounded decodes are preserved with diagnostics', () => {
  const malformed = deobfuscate(fixture(`result=decode(${JSON.stringify(alphabet[15].repeat(2))});`), options);
  assert.match(malformed.code, /result\s*=\s*decode\(/);
  assert.ok(malformed.report.diagnostics.some(item => item.code === 'UNSUPPORTED_SUBSTITUTED_HEX_VALUE'));
  const oversized = fixture(result('a'.repeat(600)));
  const length = deobfuscate(oversized, { ...options, maxDecodedStringLength: 1024 });
  assert.ok(length.report.diagnostics.some(item => item.code === 'STRING_DECODER_LENGTH_LIMIT'));
  const operations = deobfuscate(oversized, { ...options, maxDecoderOperations: 1000 });
  assert.ok(operations.report.diagnostics.some(item => item.code === 'STRING_DECODER_OPERATION_LIMIT'));
});

test('decoded literal arrays and nested primitive arrays are substituted', () => {
  const input = fixture(`var table=[decode(${JSON.stringify(encode('hello'))})];var numbers=[4,8];
    var derived=[table[0],numbers[1]];result=[derived[0],derived[1],numbers.length];`);
  const transformed = deobfuscate(input, options);
  assert.match(transformed.code, /result\s*=\s*\["hello", 8, 2\]/);
});

test('array aliases and dynamic indices retain the live table', () => {
  const transformed = deobfuscate('var table=[4,8];var alias=table;result=[alias[1],alias[index]];', { ...options, profile: 'readable' });
  assert.match(transformed.code, /result\s*=\s*\[8, alias\[index\]\]/);
  assert.match(transformed.code, /table\s*=\s*\[4, 8\]/);
});

test('array mutation, destructuring writes, methods and escapes prevent substitution', () => {
  for (const effect of ['table[0]=9;', 'table.push(9);', 'consume(table);', '[table[0]]=values;',
    'for(table[0] of values){}', 'delete table[0];', 'table.length=0;']) {
    const transformed = deobfuscate(`var table=[4,8];${effect}result=table[0];`, options);
    assert.match(transformed.code, /result\s*=\s*table\[0\]/);
  }
});

test('conditional, early closure and exported literal arrays are preserved', () => {
  for (const input of [
    'if(false){var table=[4,8]}result=table[0];',
    'read();var table=[4,8];function read(){result=table[0]}',
    'export const table=[4,8];export function read(){return table[0]}',
  ]) assert.match(deobfuscate(input, options).code, /table\[0\]/);
});

test('readable profile removes only unused proven scaffolding and reports it', () => {
  const input = fixture(`var table=[decode(${JSON.stringify(encode('hello'))})];result=table[0];`);
  const transformed = deobfuscate(input, { ...options, profile: 'readable' });
  assert.match(transformed.code, /result\s*=\s*"hello"/);
  assert.doesNotMatch(transformed.code, /Unpack|\bdecode\b|\btable\b/);
  const diagnostic = transformed.report.diagnostics.find(item => item.code === 'READABLE_HEX_SCAFFOLD_REMOVED');
  assert.ok(diagnostic);
  const live = deobfuscate(fixture('result=decode(globalThis.input);'), { ...options, profile: 'readable' });
  assert.match(live.code, /function Unpack/);
  assert.match(live.code, /decode\(globalThis\.input\)/);
});

test('layered constant resolver proves computed helpers and array keys without changing source AST', () => {
  const input = fixture(`var table=[decode(${JSON.stringify(encode('document'))}),decode(${JSON.stringify(encode('cookie'))})];result=[table[0],table[1]];`)
    .replaceAll('.split', '[outer(0)]').replaceAll('.m', '[outer(1)]')
    .replaceAll('.charAt', '[outer(2)]').replaceAll('.join', '[outer(3)]');
  const ast = parser.parse(input);
  const before = JSON.stringify(ast);
  const resolver = createStaticResolver(ast, { options: {} }, path => path.isCallExpression() &&
    path.get('callee').isIdentifier({ name: 'outer' }) ? ['split', 'm', 'charAt', 'join'][path.node.arguments[0].value] : undefined);
  const values = [];
  traverse(ast, { MemberExpression(path) {
    if (path.get('object').isIdentifier({ name: 'table' })) values.push(resolver(path));
  } });
  assert.deepEqual(values, ['document', 'cookie']);
  assert.equal(JSON.stringify(ast), before);
});

test('read-only proof resolver rejects escaped decoders and changed arrays', () => {
  for (const input of [fixture(`consume(decode);var table=[decode(${JSON.stringify(encode('hello'))})];result=table[0];`),
    "var table=['hello'];table[0]='changed';result=table[0];"]) {
    const ast = parser.parse(input), resolver = createStaticResolver(ast);
    let observed;
    traverse(ast, { AssignmentExpression(path) {
      if (path.get('left').isIdentifier({ name: 'result' })) observed = resolver(path.get('right'));
    } });
    assert.equal(observed, undefined);
  }
});
