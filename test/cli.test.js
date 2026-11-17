'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const parser = require('@babel/parser');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin/js-ast-deobfuscator.js');
const run = (args, input) => spawnSync(process.execPath, [bin, ...args], {
  input,
  encoding: 'utf8',
  cwd: root,
  timeout: 30000,
  maxBuffer: 8 * 1024 * 1024,
  windowsHide: true,
});

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'js-ast-deobfuscator-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('js-ast-deobfuscator-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}

test('CLI help, version, and pass list work without an input file', () => {
  for (const flag of ['--help', '--version', '--list-passes']) {
    const result = run([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim().length > 0);
  }
  assert.match(run(['--list-passes']).stdout, /constant-fold/);
});

test('CLI reads stdin and writes only parseable transformed code to stdout', () => {
  const result = run(['-', '--passes', 'constant-fold'], 'globalThis.result = 1 + 2;');
  assert.equal(result.status, 0, result.stderr);
  parser.parse(result.stdout);
  assert.match(result.stdout, /result\s*=\s*3/);
});

test('CLI file output, JSON report and source map are coherent', (t) => {
  const directory = temporaryDirectory(t);
  const input = path.join(directory, 'input file.js');
  const output = path.join(directory, 'output file.js');
  const reportPath = path.join(directory, 'report.json');
  const source = 'globalThis.result = 2 * 3;';
  fs.writeFileSync(input, source);
  const result = run([input, '-o', output, '--report', reportPath, '--source-map']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const code = fs.readFileSync(output, 'utf8');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const map = JSON.parse(fs.readFileSync(`${output}.map`, 'utf8'));
  parser.parse(code);
  assert.match(code, /sourceMappingURL=/);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.input.bytes, Buffer.byteLength(source));
  assert.equal(report.output.bytes, Buffer.byteLength(code));
  assert.equal(report.output.sha256, crypto.createHash('sha256').update(code).digest('hex'));
  assert.equal(map.version, 3);
  assert.ok(map.sources.some((filename) => filename.includes('input file.js')));
});

test('CLI flags override a JSON configuration file', (t) => {
  const directory = temporaryDirectory(t);
  const config = path.join(directory, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ passes: [], maxIterations: 1 }));
  const result = run(['-', '--config', config, '--passes', 'constant-fold'], 'globalThis.result = 1 + 2;');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /result\s*=\s*3/);
});

test('CLI class modernization is opt-in and reports the final stage with an original-source map', (t) => {
  const directory = temporaryDirectory(t);
  const input = path.join(directory, 'prototype.js');
  const output = path.join(directory, 'classes.js');
  const reportPath = path.join(directory, 'classes.report.json');
  const source = 'Widget.prototype.read = function () { return this.value; }; function Widget(value) { this.value = value; } globalThis.ExportedWidget = Widget;';
  fs.writeFileSync(input, source);
  const result = run([input, '--passes', '', '--modernize', 'class', '-o', output, '--report', reportPath, '--source-map']);
  assert.equal(result.status, 0, result.stderr);
  const code = fs.readFileSync(output, 'utf8');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const map = JSON.parse(fs.readFileSync(`${output}.map`, 'utf8'));
  parser.parse(code);
  assert.match(code, /class Widget/);
  assert.doesNotMatch(code, /Widget\.prototype\.read\s*=/);
  assert.equal(report.modernization.mode, 'class');
  assert.equal(report.modernization.classesConverted, 1);
  assert.equal(report.modernization.prototypeMethodsConverted, 1);
  assert.ok(map.sourcesContent.includes(source));
  assert.equal(report.output.sha256, crypto.createHash('sha256').update(code).digest('hex'));
  assert.match(result.stderr, /CLASS_/);
});

test('class modernization can be enabled through JSON configuration', (t) => {
  const directory = temporaryDirectory(t);
  const config = path.join(directory, 'classes.json');
  fs.writeFileSync(config, JSON.stringify({ passes: [], modernize: 'class' }));
  const result = run(['-', '--config', config], 'function Box() {} Box.prototype.read = function () { return 1; };');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /class Box/);
});

test('CLI rejects colliding input, output, report, and map paths before writing', (t) => {
  const directory = temporaryDirectory(t);
  const input = path.join(directory, 'input.js');
  const output = path.join(directory, 'output.js');
  const source = 'globalThis.result = 1 + 2;';
  fs.writeFileSync(input, source);
  for (const args of [
    [input, '-o', input],
    [input, '--report', input],
    [input, '-o', output, '--report', output],
    [input, '-o', output, '--source-map', '--report', `${output}.map`],
  ]) {
    const result = run(args);
    assert.ok(result.status !== null && result.status !== 0, result.stderr);
    assert.ok(result.stderr.trim().length > 0);
    assert.equal(fs.readFileSync(input, 'utf8'), source);
    assert.equal(fs.existsSync(output), false);
  }
});

test('CLI parse failure does not truncate existing output, report, or map', (t) => {
  const directory = temporaryDirectory(t);
  const input = path.join(directory, 'invalid.js');
  const output = path.join(directory, 'existing.js');
  const report = path.join(directory, 'existing.report.json');
  fs.writeFileSync(input, 'const = ;');
  for (const filename of [output, report, `${output}.map`]) fs.writeFileSync(filename, 'KEEP');
  const result = run([input, '-o', output, '--report', report, '--source-map']);
  assert.ok(result.status !== null && result.status !== 0, result.stderr);
  assert.equal(result.stdout, '');
  for (const filename of [output, report, `${output}.map`]) assert.equal(fs.readFileSync(filename, 'utf8'), 'KEEP');
});

test('CLI rejects malformed JSON config without producing code', (t) => {
  const directory = temporaryDirectory(t);
  const config = path.join(directory, 'bad.json');
  fs.writeFileSync(config, '{"passes":');
  const result = run(['-', '--config', config], '1;');
  assert.ok(result.status !== null && result.status !== 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.trim().length > 0);
});

for (const [name, args, source] of [
  ['unknown flag', ['--no-such-option'], '1;'],
  ['missing output value', ['-', '--output'], '1;'],
  ['unknown pass', ['-', '--passes', 'does-not-exist'], '1;'],
  ['invalid iteration count', ['-', '--max-iterations', '0'], '1;'],
  ['fractional iteration count', ['-', '--max-iterations', '1.5'], '1;'],
  ['trailing junk in iteration count', ['-', '--max-iterations', '2x'], '1;'],
  ['invalid source type', ['-', '--source-type', 'garbage'], '1;'],
  ['invalid modernization mode', ['-', '--modernize', 'all'], '1;'],
  ['missing modernization mode', ['-', '--modernize'], '1;'],
  ['source map without output path', ['-', '--source-map'], '1;'],
  ['invalid JavaScript', ['-'], 'const = ;'],
  ['missing input file', ['this-file-does-not-exist-174948.js'], ''],
]) {
  test(`CLI rejects ${name} with a useful stderr diagnostic`, () => {
    const result = run(args, source);
    assert.ok(result.status !== null && result.status !== 0, `${result.status}: ${result.stderr}`);
    assert.ok(result.stderr.trim().length > 0);
    assert.equal(result.stdout, '');
  });
}
