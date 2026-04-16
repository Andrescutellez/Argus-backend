// Importamos Router de Express para definir rutas de forma modular
const { Router } = require("express");

// Importamos las funciones del controlador
const { guardarDato, obtenerDatos } = require("../controllers/gpsController");

// Creamos una instancia del Router
const router = Router();

// ── Ruta POST /api/gps ──────────────────────────────────────────
// El ESP32 envía datos GPS mediante una petición POST
// El controlador "guardarDato" se encarga de validar y guardar
router.post("/", guardarDato);

// ── Ruta GET /api/gps ───────────────────────────────────────────
// Cualquier cliente (Postman, app web, etc.) puede consultar los datos
// El controlador "obtenerDatos" devuelve los últimos 100 registros
router.get("/", obtenerDatos);

// Exportamos el router para montarlo en server.js
module.exports = router;
