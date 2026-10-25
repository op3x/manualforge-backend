const { createSupportStore } = require('../lib/support/store');

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return '';
  return process.argv[index + 1] || '';
}

async function main() {
  const phone = arg('--phone');
  const actor = arg('--actor') || 'staff';
  if (!phone) {
    console.error('Usage: node scripts/support-opt-out.js --phone +15551212000 --actor email:name');
    process.exit(1);
  }
  const store = createSupportStore();
  store.recordStaffOptOut(phone, actor);
  console.log('opt-out recorded');
}

main().catch((err) => {
  console.error(err && err.message ? err.message : 'opt-out failed');
  process.exit(1);
});
