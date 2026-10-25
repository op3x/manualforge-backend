const fs = require('fs');
const path = require('path');

function corpusRoot() {
  if (Object.prototype.hasOwnProperty.call(process.env, 'MANUALOS_CORPUS')) {
    const configured = process.env.MANUALOS_CORPUS;
    if (!configured || !fs.existsSync(configured)) {
      throw new Error(`MANUALOS_CORPUS does not exist: ${configured || '(empty)'}`);
    }
    return configured;
  }
  const store = '/cursor/stores/bot/manualos-test-corpus/';
  if (fs.existsSync(path.join(store, 'manifest.json'))) return store;
  const fixture = path.join(__dirname, 'fixtures', 'corpus');
  if (fs.existsSync(path.join(fixture, 'manifest.json'))) return fixture;
  return store;
}

function corpusAvailable(root = corpusRoot()) {
  return fs.existsSync(path.join(root, 'manifest.json'));
}

function corpusHas(rel, root = corpusRoot()) {
  return fs.existsSync(path.join(root, rel));
}

function corpusSkip(root = corpusRoot()) {
  if (corpusAvailable(root)) return false;
  if (process.env.CI || process.env.GITHUB_ACTIONS) return false;
  return true;
}

module.exports = { corpusRoot, corpusAvailable, corpusHas, corpusSkip };
