const Gps = require('../models/Gps');
const { connectedDevices, sendCommand } = require('../tcp/tcpServer');

const VALID_COMMANDS = ['ARM', 'DISARM', 'ALERT', 'ENGINE_CUT'];

const getDeviceStatus = async (req, res) => {
  const { deviceId } = req.params;
  try {
    const connected = connectedDevices.has(deviceId);
    const latest = await Gps.findOne({ deviceId }).sort({ timestamp: -1 });
    return res.status(200).json({
      deviceId,
      connected,
      lastSeen: latest?.timestamp ?? null,
      lat: latest?.lat ?? null,
      lon: latest?.lon ?? null,
      speed: latest?.speed ?? null,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

const postCommand = (req, res) => {
  const { deviceId } = req.params;
  const { command } = req.body ?? {};

  if (!command || !VALID_COMMANDS.includes(command)) {
    return res.status(400).json({
      message: `Comando inválido. Válidos: ${VALID_COMMANDS.join(', ')}`,
    });
  }

  const delivered = sendCommand(deviceId, command);
  if (delivered) {
    return res.status(200).json({ message: 'Comando enviado', delivered: true });
  }
  // Device offline — command queued for next reconnect
  return res.status(202).json({ message: 'Dispositivo offline. Comando encolado.', delivered: false });
};

module.exports = { getDeviceStatus, postCommand };
