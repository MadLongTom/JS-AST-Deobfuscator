'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const parser = require('@babel/parser');
const types = require('@babel/types');
const root = path.resolve(__dirname, '..');
let checked = 0;

function checkExecutionBoundary(file) {
  const relative = path.relative(root, file);
  if (!relative.startsWith('src' + path.sep) && !relative.startsWith('bin' + path.sep)) return;
  const ast = parser.parse(fs.readFileSync(file, 'utf8'), { sourceType: 'unambiguous' });
  types.traverseFast(ast, node => {
    const call = types.isCallExpression(node) || types.isNewExpression(node);
    const direct = call && types.isIdentifier(node.callee) && ['eval', 'Function'].includes(node.callee.name);
    const property = call && types.isMemberExpression(node.callee) && (
      !node.callee.computed && types.isIdentifier(node.callee.property, { name: 'eval' }) ||
      node.callee.computed && types.isStringLiteral(node.callee.property, { value: 'eval' })
    );
    const vmImport = types.isImportDeclaration(node) && ['vm', 'node:vm'].includes(node.source.value) ||
      call && types.isIdentifier(node.callee, { name: 'require' }) && types.isStringLiteral(node.arguments[0]) && ['vm', 'node:vm'].includes(node.arguments[0].value);
    if (direct || property || vmImport) {
      process.stderr.write(`Execution-boundary check failed: ${relative}:${node.loc.start.line}\n`);
      process.exitCode = 1;
    }
  });
}

function check(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures') check(file);
    } else if (/\.(?:c?js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) {
        process.stderr.write(result.stderr || `Syntax check failed: ${file}\n`);
        process.exitCode = 1;
      } else checkExecutionBoundary(file);
      checked++;
    }
  }
}

for (const directory of ['src', 'bin', 'scripts', 'test']) check(path.join(root, directory));
console.log(`Syntax checked ${checked} files; production input-execution guards checked.`);
