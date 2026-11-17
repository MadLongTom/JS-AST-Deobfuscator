#!/usr/bin/env node
'use strict';

// Compatibility entry point: node main.js <input> -o <output>
process.exitCode = require('./bin/js-ast-deobfuscator').run();
