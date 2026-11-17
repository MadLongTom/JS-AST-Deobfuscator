#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const parser = require('@babel/parser');
const { indexWebpackModules, webpackModuleExcerpts } = require('../src/readability/webpack');

function extractModules(input, directory) {
  const source = fs.readFileSync(input, 'utf8');
  const ast = parser.parse(source, { sourceType: 'unambiguous' });
  const bundles = indexWebpackModules(ast);
  const excerpts = webpackModuleExcerpts(ast);
  const root = path.resolve(directory);
  if (path.resolve(input) === path.join(root, 'index.json')) throw new Error('Input and index output must differ.');
  fs.mkdirSync(root, { recursive: true });
  for (const excerpt of excerpts) {
    const id = encodeURIComponent(String(excerpt.id)).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16)}`);
    const filename = `bundle-${excerpt.bundle}-module-${id.padStart(3, '0')}.js`;
    const target = path.join(root, filename);
    if (path.resolve(input) === target) throw new Error('Input and module output must differ.');
    const header = `// Reading excerpt: bundle ${excerpt.bundle}, module ${excerpt.id}.\n// Depends on its original lexical scope; this file is not a standalone module.\n// Full bundle lines ${excerpt.line}-${excerpt.endLine}.\n`;
    fs.writeFileSync(target, header + excerpt.code + '\n');
    const module = bundles.find(bundle => bundle.bundle === excerpt.bundle).modules.find(module => module.id === excerpt.id);
    module.file = filename;
  }
  const index = {
    schemaVersion: 1,
    input: { filename: path.resolve(input), sha256: createHash('sha256').update(source).digest('hex') },
    kind: 'webpack-factory-reading-excerpts',
    standalone: false,
    bundles,
  };
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  return index;
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node scripts/extract-modules.cjs <readable-bundle.js> <output-directory>');
    const index = extractModules(process.argv[2], process.argv[3]);
    console.log(`Indexed ${index.bundles.length} bundles and ${index.bundles.reduce((count, bundle) => count + bundle.modules.length, 0)} module factories; no source was executed.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { extractModules };
