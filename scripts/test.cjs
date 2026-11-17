'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'test'))
  .filter(filename => filename.endsWith('.test.js'))
  .sort()
  .map(filename => path.join(root, 'test', filename));
if (!files.length) throw new Error('No test files were found.');
// Explicit files keep Node 20 / Windows independent of shell glob expansion,
// and prevent real-world fixture scripts from being discovered and executed.
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
