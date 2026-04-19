const Gps = require('../models/Gps');
const { log } = require('./logger');

const queue = [];
const FLUSH_INTERVAL_MS = 2000;
const BATCH_SIZE = 50;

async function flush() {
  if (queue.length === 0) return;
  const batch = queue.splice(0, BATCH_SIZE);
  try {
    await Gps.insertMany(batch, { ordered: false });
    log('info', 'queue.flush', { count: batch.length });
  } catch (err) {
    log('error', 'queue.flush.error', { message: err.message, dropped: batch.length });
  }
}

function enqueue(data) {
  queue.push(data);
}

function startWorker() {
  setInterval(flush, FLUSH_INTERVAL_MS);
  log('info', 'queue.worker.start', { intervalMs: FLUSH_INTERVAL_MS });
}

module.exports = { enqueue, startWorker };
