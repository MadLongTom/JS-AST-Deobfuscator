#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { deobfuscate, listPasses } = require('../src');
const { version } = require('../package.json');

const HELP = `Usage: js-ast-deobfuscator <input.js | -> [options]

Static JavaScript deobfuscation; supplied source is never executed.

  -o, --output <file>         Write code to a file (default: stdout)
      --report <file>         Write a JSON transformation report
      --source-map            Write an external map; requires --output
      --passes <a,b,...>       Select passes in this exact order
      --max-iterations <n>     Iteration limit, 1..50 (safe: 5, readable: 12)
      --source-type <type>     unambiguous, script or module
      --profile <name>         safe (default) or readable analysis output
      --modernize <type>       Opt-in class reconstruction after deobfuscation
      --rename                 Rename private bindings for readable analysis output
      --assume-data-eval       Opt-in data-only eval assumption; requires readable
      --config <file>          Load JSON API options; flags take priority
      --list-passes            List builtin passes
  -h, --help                   Show help
  -v, --version                Print version

Examples:
  js-ast-deobfuscator input.js -o output.js --report report.json
  js-ast-deobfuscator input.js -o output.js --source-map
  cat input.js | js-ast-deobfuscator -
`;

function fail(message) {
  const error = new Error(message);
  error.code = 'CLI_ERROR';
  throw error;
}

function parseArguments(argv) {
  const parsed = { flags: {}, input: null, output: null, report: null, config: null };
  const valueFlags = new Set(['-o', '--output', '--report', '--passes', '--max-iterations', '--source-type', '--profile', '--modernize', '--config']);
  let positional = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!positional && token === '--') { positional = true; continue; }
    if (!positional && ['-h', '--help'].includes(token)) { parsed.help = true; continue; }
    if (!positional && ['-v', '--version'].includes(token)) { parsed.version = true; continue; }
    if (!positional && token === '--list-passes') { parsed.list = true; continue; }
    if (!positional && token === '--source-map') { parsed.flags.sourceMaps = true; continue; }
    if (!positional && token === '--rename') { parsed.flags.renameBindings = true; continue; }
    if (!positional && token === '--assume-data-eval') { parsed.flags.assumeDataEval = true; continue; }
    if (!positional && valueFlags.has(token)) {
      const value = argv[++index];
      if (value === undefined || (value.startsWith('-') && value !== '-')) fail(`Missing value for ${token}.`);
      switch (token) {
        case '-o': case '--output': parsed.output = value; break;
        case '--report': parsed.report = value; break;
        case '--config': parsed.config = value; break;
        case '--passes': parsed.flags.passes = value === '' ? [] : value.split(','); break;
        case '--source-type': parsed.flags.sourceType = value; break;
        case '--profile': parsed.flags.profile = value; break;
        case '--modernize': parsed.flags.modernize = value; break;
        case '--max-iterations':
          if (!/^\d+$/.test(value)) fail('--max-iterations needs an integer between 1 and 50.');
          parsed.flags.maxIterations = Number(value);
          break;
      }
      continue;
    }
    if (!positional && token.startsWith('-') && token !== '-') fail(`Unknown option: ${token}.`);
    if (parsed.input !== null) fail('Provide exactly one input file.');
    parsed.input = token;
  }
  return parsed;
}

function canonical(filename) {
  const resolved = path.resolve(filename);
  let result;
  try { result = fs.realpathSync(resolved); }
  catch {
    // Resolve existing ancestors as well, so symlinked directories cannot hide collisions.
    const parent = path.dirname(resolved);
    result = parent === resolved ? resolved : path.join(canonical(parent), path.basename(resolved));
  }
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

function writeAtomic(filename, contents) {
  const target = path.resolve(filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function run(argv = process.argv.slice(2)) {
  try {
    const parsed = parseArguments(argv);
    if (parsed.help) { process.stdout.write(HELP); return 0; }
    if (parsed.version) { process.stdout.write(version + '\n'); return 0; }
    if (parsed.list) {
      for (const pass of listPasses()) process.stdout.write(`${pass.name}\t${pass.description}\n`);
      return 0;
    }
    if (parsed.input === null) fail('Input is required. Use --help for usage.');
    let config = {};
    if (parsed.config) {
      try { config = JSON.parse(fs.readFileSync(parsed.config, 'utf8').replace(/^\uFEFF/, '')); }
      catch (cause) { fail(`Cannot read JSON config: ${cause.message}`); }
      if (!config || typeof config !== 'object' || Array.isArray(config)) fail('Config must be a JSON object.');
      if (Object.hasOwn(config, 'customPasses')) fail('customPasses is available only through the JavaScript API.');
    }
    const options = { filename: parsed.input === '-' ? 'stdin.js' : parsed.input, ...config, ...parsed.flags };
    const output = parsed.output && parsed.output !== '-' ? parsed.output : null;
    if (options.sourceMaps && !output) fail('--source-map requires a file --output.');
    if (parsed.report === '-') fail('--report requires a file path; stdout is reserved for code.');
    const mapFile = options.sourceMaps ? `${output}.map` : null;
    const paths = [parsed.input === '-' ? null : parsed.input, output, parsed.report, mapFile].filter(Boolean);
    const identities = paths.map(canonical);
    if (new Set(identities).size !== identities.length) fail('Input, output, report and source map paths must be different.');
    const source = fs.readFileSync(parsed.input === '-' ? 0 : parsed.input, 'utf8');
    const result = deobfuscate(source, options);
    let content = result.code + '\n';
    if (mapFile) {
      const map = { ...result.map, file: path.basename(output) };
      writeAtomic(mapFile, JSON.stringify(map) + '\n');
      content += `//# sourceMappingURL=${encodeURIComponent(path.basename(mapFile))}\n`;
    }
    result.report.output = { bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') };
    if (output) writeAtomic(output, content);
    else process.stdout.write(content);
    if (parsed.report) writeAtomic(parsed.report, JSON.stringify(result.report, null, 2) + '\n');
    for (const diagnostic of result.report.diagnostics) {
      process.stderr.write(`[${diagnostic.code}] ${diagnostic.message}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error.code || 'IO_ERROR'}: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = run();
module.exports = { run };
