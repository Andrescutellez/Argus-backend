const crypto = require('crypto');

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

// Device computes: HMAC-SHA256(deviceId|timestamp|lat|lng, secret).slice(0,16)
function verifySignature(deviceId, timestamp, lat, lng, signature) {
  const payload = `${deviceId}|${timestamp}|${lat}|${lng}`;
  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(payload)
    .digest('hex')
    .slice(0, 16);
  // constant-time compare to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(signature.slice(0, 16).padEnd(16, '\0'), 'utf8')
    );
  } catch {
    return false;
  }
}

module.exports = { isAllowed, verifySignature };
