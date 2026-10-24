const { readdirSync } = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const files = readdirSync(path.join(root, 'test'))
  .filter((name) => name.endsWith('.js'))
  .sort()
  .map((name) => path.join('test', name));
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
