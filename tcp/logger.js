function log(level, event, data = {}) {
  const entry = { ts: new Date().toISOString(), level, event, ...data };
  console.log(JSON.stringify(entry));
}

module.exports = { log };
