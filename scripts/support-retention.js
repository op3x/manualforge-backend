require('dotenv').config();
const { sweepSupportRetention } = require('../lib/support/retention');

sweepSupportRetention({ env: process.env })
  .then((counts) => {
    if (counts.errors) process.exitCode = 1;
  })
  .catch((err) => {
    console.error('Support retention failed', err && err.code ? err.code : 'error');
    process.exitCode = 1;
  });
