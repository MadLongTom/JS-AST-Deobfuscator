'use strict';

const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const { DeobfuscationError } = require('./errors');
const { analyzeAst } = require('./analysis');

const DEFAULT_ORDER = [
  'normalize-literals', 'decode-string-arrays', 'decode-substituted-hex', 'normalize-statements',
  'inline-constants', 'inline-aliases', 'inline-objects', 'inline-wrappers', 'constant-fold',
  'neutralize-self-defense', 'control-flow', 'dead-code', 'cleanup-decoders',
];
const ALLOWED_OPTIONS = new Set([
  'passes', 'maxIterations', 'sourceType', 'sourceMaps', 'filename', 'plugins', 'customPasses',
  'maxDecoderOperations', 'maxStringArrayRotations', 'maxDecodedStringLength',
  'profile', 'modernize', 'renameBindings', 'assumeDataEval',
]);

function invalid(message) {
  throw new DeobfuscationError('INVALID_OPTIONS', message);
}

function registry(customPasses = []) {
  const generic = require('./passes');
  const entries = Array.isArray(generic) ? generic : generic.passes;
  const builtins = entries;
  const result = new Map();
  for (const pass of [...builtins, ...customPasses]) {
    if (!pass || typeof pass.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(pass.name) || typeof pass.run !== 'function') {
      invalid('Each custom pass needs a kebab-case name and a synchronous run(ast, context) function.');
    }
    if (result.has(pass.name)) invalid(`Duplicate pass name: ${pass.name}`);
    result.set(pass.name, pass);
  }
  return result;
}

function optionsFor(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid('Options must be an object.');
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.has(key)) invalid(`Unknown option: ${key}`);
  }
  const normalized = {
    maxIterations: options.profile === 'readable' ? 12 : 5,
    profile: 'safe',
    modernize: false,
    renameBindings: false,
    assumeDataEval: false,
    sourceType: 'unambiguous',
    sourceMaps: false,
    filename: 'input.js',
    plugins: ['jsx'],
    customPasses: [],
    maxDecoderOperations: 2000000,
    maxStringArrayRotations: 10000,
    maxDecodedStringLength: 100000,
    ...options,
  };
  if (!Number.isInteger(normalized.maxIterations) || normalized.maxIterations < 1 || normalized.maxIterations > 50) {
    invalid('maxIterations must be an integer between 1 and 50.');
  }
  if (!['unambiguous', 'script', 'module'].includes(normalized.sourceType)) invalid('Invalid sourceType.');
  if (!['safe', 'readable'].includes(normalized.profile)) invalid('profile must be safe or readable.');
  if (normalized.modernize === undefined) normalized.modernize = false;
  if (normalized.modernize !== false && normalized.modernize !== 'class') invalid('modernize must be false or class.');
  if (typeof normalized.renameBindings !== 'boolean') invalid('renameBindings must be a boolean.');
  if (normalized.renameBindings && normalized.profile !== 'readable') invalid('renameBindings requires the readable profile.');
  if (typeof normalized.assumeDataEval !== 'boolean') invalid('assumeDataEval must be a boolean.');
  if (normalized.assumeDataEval && normalized.profile !== 'readable') invalid('assumeDataEval requires the readable profile.');
  if (typeof normalized.sourceMaps !== 'boolean') invalid('sourceMaps must be a boolean.');
  if (typeof normalized.filename !== 'string' || !normalized.filename) invalid('filename must be a nonempty string.');
  if (!Array.isArray(normalized.plugins) || !normalized.plugins.every(plugin => typeof plugin === 'string' || (Array.isArray(plugin) && typeof plugin[0] === 'string'))) {
    invalid('plugins must be a Babel parser plugin array.');
  }
  if (!Array.isArray(normalized.customPasses)) invalid('customPasses must be an array.');
  for (const [name, minimum, maximum] of [
    ['maxDecoderOperations', 1000, 10000000],
    ['maxStringArrayRotations', 1, 100000],
    ['maxDecodedStringLength', 1024, 1000000],
  ]) {
    if (!Number.isInteger(normalized[name]) || normalized[name] < minimum || normalized[name] > maximum) {
      invalid(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }
  }
  const all = registry(normalized.customPasses);
  const names = options.passes === undefined
    ? [...DEFAULT_ORDER, ...normalized.customPasses.map(pass => pass.name)] : options.passes;
  if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) invalid('passes must be an array of pass names.');
  if (new Set(names).size !== names.length) invalid('passes must not contain duplicates.');
  for (const name of names) if (!all.has(name)) invalid(`Unknown pass: ${name}`);
  normalized.passes = [...names];
  return { options: normalized, selected: names.map(name => all.get(name)) };
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function metadata(code, filename) {
  return { ...(filename ? { filename } : {}), bytes: Buffer.byteLength(code), sha256: hash(code) };
}

function errorMessage(cause) {
  try {
    return cause && typeof cause.message === 'string' ? cause.message : String(cause);
  } catch {
    return 'Unknown thrown value';
  }
}

function format(ast, source, options, sourceMaps = false, passName) {
  try {
    return generate(ast, {
      comments: true,
      compact: false,
      jsescOption: { minimal: true },
      sourceMaps,
      sourceFileName: options.filename,
    }, source);
  } catch (cause) {
    throw new DeobfuscationError('PASS_ERROR', `Could not generate output: ${errorMessage(cause)}`, { cause, passName });
  }
}

/** Static AST transformations. Never executes the supplied source. */
function deobfuscate(source, inputOptions = {}) {
  if (typeof source !== 'string') invalid('Source must be a string.');
  const started = performance.now();
  const { options, selected } = optionsFor(inputOptions);
  let ast;
  try {
    ast = parser.parse(source, {
      sourceType: options.sourceType,
      sourceFilename: options.filename,
      plugins: options.plugins,
      allowReturnOutsideFunction: false,
    });
  } catch (cause) {
    throw new DeobfuscationError('PARSE_ERROR', cause.message, { cause, location: cause.loc });
  }
  const report = {
    schemaVersion: 1,
    profile: options.profile,
    input: metadata(source, options.filename),
    output: null,
    iterations: 0,
    converged: selected.length === 0,
    passes: [],
    totals: { changes: 0, durationMs: 0 },
    diagnostics: [],
    assumptions: [],
    residuals: { before: analyzeAst(ast), after: null },
  };
  const diagnosticKeys = new Set();
  const context = {
    options,
    state: new Map(),
    warn(code, message, details) {
      const entry = { level: 'warning', code, message, ...(details === undefined ? {} : { details }) };
      const key = JSON.stringify(entry);
      if (!diagnosticKeys.has(key)) {
        diagnosticKeys.add(key);
        report.diagnostics.push(entry);
      }
    },
  };
  context.assumeDataEval = (path, classification) => {
    const location = path.node.loc ? { line: path.node.loc.start.line, column: path.node.loc.start.column } : null;
    const entry = {
      kind: classification.kind, location, proven: false,
      introducedNames: classification.introducedNames,
      assumptions: classification.assumptions,
    };
    const key = JSON.stringify(entry);
    if (!report.assumptions.some(item => JSON.stringify(item) === key)) report.assumptions.push(entry);
    context.warn('ASSUMED_DATA_EVAL', 'A legacy eval parser was treated as data-only by explicit readable-mode opt-in; its call and introduced-name barriers were retained.', entry);
  };
  let previous = hash(format(ast, source, options).code);
  let lastPassName;
  const seen = new Set([previous]);
  for (let iteration = 1; selected.length && iteration <= options.maxIterations; iteration++) {
    report.iterations = iteration;
    for (const pass of selected) {
      lastPassName = pass.name;
      const passStarted = performance.now();
      let changes;
      try {
        traverse(ast, { Program(path) { path.scope.crawl(); path.stop(); } });
        changes = pass.run(ast, context);
        if (changes && typeof changes.then === 'function') {
          // Reject asynchronous plugins without leaking an unhandled rejection.
          Promise.resolve(changes).catch(() => {});
          throw new TypeError('Pass run() must be synchronous.');
        }
        if (!Number.isSafeInteger(changes) || changes < 0) {
          throw new TypeError('Pass run() must synchronously return a nonnegative integer.');
        }
      } catch (cause) {
        throw new DeobfuscationError('PASS_ERROR', `Pass ${pass.name} failed: ${errorMessage(cause)}`, { cause, passName: pass.name });
      }
      report.passes.push({
        name: pass.name, iteration, changes,
        durationMs: Math.round((performance.now() - passStarted) * 1000) / 1000,
      });
      report.totals.changes += changes;
    }
    const current = hash(format(ast, source, options, false, lastPassName).code);
    if (current === previous) {
      report.converged = true;
      break;
    }
    if (seen.has(current)) {
      context.warn('PIPELINE_CYCLE', 'The selected passes produced a repeated AST; iteration stopped.');
      break;
    }
    seen.add(current);
    previous = current;
  }
  if (!report.converged && !report.diagnostics.some(item => item.code === 'PIPELINE_CYCLE')) {
    context.warn('MAX_ITERATIONS', `Stopped at the configured limit of ${options.maxIterations} iterations.`);
  }
  // Modernization is a separate, opt-in final stage. Iterative deobfuscation
  // must finish before constructor/prototype groups are reconstructed.
  if (options.modernize === 'class') {
    lastPassName = 'modernize-classes';
    const stageStarted = performance.now();
    try {
      traverse(ast, { Program(path) { path.scope.crawl(); path.stop(); } });
      const { modernizeInheritance } = require('./modernize/inheritance');
      const inheritance = modernizeInheritance(ast, context);
      traverse(ast, { Program(path) { path.scope.crawl(); path.stop(); } });
      const { modernizeClasses } = require('./modernize/classes');
      const regular = modernizeClasses(ast, context);
      const modernization = {
        ...regular,
        changes: inheritance.changes + regular.changes,
        converted: [...inheritance.converted, ...regular.converted],
        skipped: [...inheritance.skipped, ...regular.skipped],
        inheritanceClassesConverted: inheritance.converted.length,
      };
      context.state.set('class-modernization', modernization);
      report.modernization = {
        mode: 'class',
        ...modernization,
        classesConverted: modernization.converted.length,
        prototypeMethodsConverted: modernization.converted.reduce((sum, item) => sum + item.methods, 0),
        staticMethodsConverted: modernization.converted.reduce((sum, item) => sum + item.staticMethods, 0),
        durationMs: Math.round((performance.now() - stageStarted) * 1000) / 1000,
      };
      report.totals.modernizationChanges = modernization.changes;
    } catch (cause) {
      throw new DeobfuscationError('PASS_ERROR', `Class modernization failed: ${errorMessage(cause)}`, { cause, passName: lastPassName });
    }
  }
  if (options.renameBindings) {
    lastPassName = 'rename-bindings';
    const stageStarted = performance.now();
    try {
      traverse(ast, { Program(path) { path.scope.crawl(); path.stop(); } });
      const naming = require('./readability/rename-bindings');
      const changes = naming.run(ast, context);
      report.readability = {
        ...context.state.get('readability:renaming'),
        changes,
        durationMs: Math.round((performance.now() - stageStarted) * 1000) / 1000,
      };
      report.totals.readabilityChanges = changes;
    } catch (cause) {
      throw new DeobfuscationError('PASS_ERROR', `Binding renaming failed: ${errorMessage(cause)}`, { cause, passName: lastPassName });
    }
  }
  const result = format(ast, source, options, options.sourceMaps, lastPassName);
  // A pass must never leave an invalid AST or invalid generated program unnoticed.
  try {
    parser.parse(result.code, { sourceType: options.sourceType, plugins: options.plugins });
  } catch (cause) {
    throw new DeobfuscationError('PASS_ERROR', `Generated output is invalid: ${errorMessage(cause)}`, { cause, location: cause.loc, passName: lastPassName });
  }
  report.output = metadata(result.code);
  report.residuals.after = analyzeAst(ast);
  report.totals.durationMs = Math.round((performance.now() - started) * 1000) / 1000;
  return { code: result.code, map: result.map || null, report };
}

function listPasses() {
  const all = registry();
  return DEFAULT_ORDER.map(name => ({ name, description: all.get(name).description || '' }));
}

module.exports = { deobfuscate, listPasses, DeobfuscationError };
