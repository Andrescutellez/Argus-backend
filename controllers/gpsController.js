// Importamos el modelo Gps para interactuar con la colección en MongoDB
const Gps = require("../models/Gps");

// ─────────────────────────────────────────────
// CONTROLADOR: guardarDato
// Método: POST /api/gps
// Recibe los datos del ESP32 y los guarda en MongoDB
// ─────────────────────────────────────────────
const guardarDato = async (req, res) => {
  try {
    // Extraemos los campos que vienen en el cuerpo (body) de la solicitud
    const { deviceId, lat, lon, speed, timestamp } = req.body;

    // ── Validación de campos obligatorios ──────
    // Si falta deviceId, lat o lon, respondemos con error 400 (Bad Request)
    if (!deviceId || lat === undefined || lon === undefined) {
      return res.status(400).json({
        message: "Campos requeridos: deviceId, lat, lon",
      });
    }

    // ── Validación de tipo numérico para lat y lon ──
    // parseFloat convierte texto a número; isNaN detecta si NO es un número válido
    if (isNaN(parseFloat(lat)) || isNaN(parseFloat(lon))) {
      return res.status(400).json({
        message: "lat y lon deben ser números válidos",
      });
    }

    // ── Validación de rango geográfico ──────────
    // La latitud va de -90 a 90 y la longitud de -180 a 180
    if (parseFloat(lat) < -90 || parseFloat(lat) > 90) {
      return res.status(400).json({ message: "lat debe estar entre -90 y 90" });
    }
    if (parseFloat(lon) < -180 || parseFloat(lon) > 180) {
      return res.status(400).json({ message: "lon debe estar entre -180 y 180" });
    }

    // ── Creamos el objeto que se guardará en MongoDB ──
    const nuevoDato = new Gps({
      deviceId,               // ID del dispositivo
      lat: parseFloat(lat),   // Convertimos a número por seguridad
      lon: parseFloat(lon),   // Convertimos a número por seguridad
      speed: speed !== undefined ? parseFloat(speed) : 0, // Velocidad (opcional)
      timestamp: timestamp ? new Date(timestamp) : Date.now(), // Fecha del dato
    });

    // ── Guardamos en la base de datos ────────────
    await nuevoDato.save();

    // ── Log en consola para monitoreo ────────────
    // Formato: [fecha y hora] deviceId -> lat, lon
    const fechaLog = new Date().toISOString(); // Fecha actual en formato ISO
    console.log(`[${fechaLog}] ${deviceId} -> ${lat}, ${lon}`);

    // ── Respondemos al cliente (ESP32 o Postman) ──
    // Código 201 = "Created" (recurso creado exitosamente)
    res.status(201).json({ message: "OK" });

  } catch (error) {
    // Si hubo un error inesperado, lo registramos y respondemos con 500
    console.error("Error al guardar dato GPS:", error.message);
    res.status(500).json({ message: "Error interno del servidor" });
  }
};

// ─────────────────────────────────────────────
// CONTROLADOR: obtenerDatos
// Método: GET /api/gps
// Devuelve los últimos 100 registros GPS ordenados por fecha descendente
// ─────────────────────────────────────────────
const obtenerDatos = async (req, res) => {
  try {
    // find({}) obtiene todos los documentos de la colección
    // sort({ timestamp: -1 }) ordena del más reciente al más antiguo
    // limit(100) limita el resultado a 100 registros
    const datos = await Gps.find({})
      .sort({ timestamp: -1 })
      .limit(100);

    // Respondemos con el arreglo de datos en formato JSON
    // Código 200 = "OK"
    res.status(200).json(datos);

  } catch (error) {
    // Si hubo un error al consultar la BD, lo informamos
    console.error("Error al obtener datos GPS:", error.message);
    res.status(500).json({ message: "Error interno del servidor" });
  }
};

// Exportamos ambos controladores para usarlos en las rutas
module.exports = { guardarDato, obtenerDatos };
