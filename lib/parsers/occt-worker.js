const { parentPort, workerData } = require('worker_threads');

async function run() {
  try {
    const factory = require('occt-import-js');
    const occt = await factory();
    const result = workerData.format === 'iges'
      ? occt.ReadIgesFile(workerData.buffer, null)
      : occt.ReadStepFile(workerData.buffer, null);
    const names = [];
    const visit = (node) => {
      if (!node) return;
      if (node.name) names.push(String(node.name));
      for (const child of node.children || []) visit(child);
    };
    visit(result && result.root);
    let min = null;
    let max = null;
    for (const mesh of (result && result.meshes) || []) {
      const position = mesh.attributes && (mesh.attributes.position || mesh.attributes.POSITION);
      const array = position && (position.array || position);
      if (!array || !array.length) continue;
      for (let i = 0; i + 2 < array.length; i += 3) {
        const point = [array[i], array[i + 1], array[i + 2]];
        if (!min) {
          min = point.slice();
          max = point.slice();
        } else {
          point.forEach((value, index) => {
            min[index] = Math.min(min[index], value);
            max[index] = Math.max(max[index], value);
          });
        }
      }
    }
    parentPort.postMessage({
      ok: Boolean(result && (result.success || names.length)),
      assemblies: names.filter(Boolean).slice(0, 200),
      boundingBox: min ? { min, max } : null,
    });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: 'importer-unavailable' });
  }
}

run();
