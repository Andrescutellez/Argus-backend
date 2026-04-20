const SECRET = process.env.TCP_SECRET || 'argus-dev-secret';

// Comma-separated device IDs in env: ALLOWED_DEVICES=ESP32-001,ESP32-002
const ALLOWED_DEVICES = new Set(
  (process.env.ALLOWED_DEVICES || 'ESP32-001,ESP32-002')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)
);

function isAllowed(deviceId) {
  return ALLOWED_DEVICES.has(deviceId);
}

function crc32Argus(text) {
  let crc = 0xffffffff;
  for (let i = 0; i < text.length; i += 1) {
    crc ^= text.charCodeAt(i);
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function verifySignature(deviceId, timestamp, lat, lng, signature) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return false;
  }

  const payload = `${deviceId}|${timestamp}|${lat.toFixed(6)}|${lng.toFixed(6)}|${SECRET}`;
  const expected = crc32Argus(payload).toString(16).toUpperCase().padStart(8, '0');
  return expected === String(signature || '').trim().toUpperCase();
}

module.exports = { isAllowed, verifySignature };
