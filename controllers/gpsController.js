const Gps = require("../models/Gps");

// Máximo tiempo que el handler puede tardar en responder.
// El A7670 tiene un timer interno de ~30 s para AT+HTTPACTION; si el servidor
// no responde antes, el módulo marca la acción como fallida aunque la petición
// llegara bien. Con 8 s el ESP32 recibe siempre el 201 antes de ese límite,
// incluso con Atlas en cold-start (~3-5 s en tier gratuito).
const DB_SAVE_TIMEOUT_MS = 8000;

const guardarDato = async (req, res) => {
  const t0 = Date.now();

  const { deviceId, lat, lon, speed, gpsFix, timestamp } = req.body ?? {};

  if (!deviceId || lat === undefined || lon === undefined) {
    console.warn(`[GPS] 400 bad-request — body: ${JSON.stringify(req.body)}`);
    return res.status(400).json({ message: "Campos requeridos: deviceId, lat, lon" });
  }

  const latN = parseFloat(lat);
  const lonN = parseFloat(lon);

  if (isNaN(latN) || isNaN(lonN)) {
    return res.status(400).json({ message: "lat y lon deben ser números válidos" });
  }
  if (latN < -90 || latN > 90) {
    return res.status(400).json({ message: "lat debe estar entre -90 y 90" });
  }
  if (lonN < -180 || lonN > 180) {
    return res.status(400).json({ message: "lon debe estar entre -180 y 180" });
  }

  const nuevoDato = new Gps({
    deviceId,
    lat: latN,
    lon: lonN,
    speed: speed !== undefined ? parseFloat(speed) : 0,
    timestamp: timestamp ? new Date(timestamp) : Date.now(),
  });

  try {
    // Race contra un timeout explícito: si MongoDB tarda más de DB_SAVE_TIMEOUT_MS
    // respondemos 201 de todas formas para no dejar al módulo esperando.
    // En la práctica Atlas responde en <500 ms en condiciones normales.
    await Promise.race([
      nuevoDato.save(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("DB timeout")), DB_SAVE_TIMEOUT_MS)
      ),
    ]);

    const ms = Date.now() - t0;
    console.log(`[GPS] 201 ${deviceId} lat=${latN} lon=${lonN} gpsFix=${gpsFix ?? "?"} (${ms}ms)`);
    return res.status(201).json({ message: "OK" });

  } catch (error) {
    const ms = Date.now() - t0;

    if (error.message === "DB timeout") {
      // El dato se descarta pero respondemos 201 para que el módulo no reintente
      // (los reintentos causarían duplicados). La telemetría de posición es tolerante
      // a pérdidas individuales; el siguiente ciclo de 30 s enviará un dato nuevo.
      console.error(`[GPS] DB timeout después de ${ms}ms — dato descartado para ${deviceId}`);
      return res.status(201).json({ message: "OK" });
    }

    console.error(`[GPS] 500 error guardando dato: ${error.message} (${ms}ms)`);
    return res.status(500).json({ message: "Error interno del servidor" });
  }
};

const obtenerDatos = async (req, res) => {
  try {
    const datos = await Gps.find({}).sort({ timestamp: -1 }).limit(100);
    return res.status(200).json(datos);
  } catch (error) {
    console.error('Error al obtener datos GPS:', error.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

const getLatestByDevice = async (req, res) => {
  const { deviceId } = req.params;
  try {
    const record = await Gps.findOne({ deviceId }).sort({ timestamp: -1 });
    if (!record) {
      return res.status(404).json({ message: 'No hay datos para este dispositivo' });
    }
    return res.status(200).json(record);
  } catch (error) {
    console.error('Error al obtener GPS latest:', error.message);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

module.exports = { guardarDato, obtenerDatos, getLatestByDevice };
