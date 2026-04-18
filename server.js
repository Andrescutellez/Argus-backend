// ─────────────────────────────────────────────────────────────
// Argus Backend - Servidor principal
// Sistema IoT GPS para dispositivos ESP32
// ─────────────────────────────────────────────────────────────

// dotenv carga las variables del archivo .env en process.env
// DEBE ser la primera línea antes de cualquier otro import
require("dotenv").config();

// Validate required environment variables
if (!process.env.MONGO_URI) {
  console.error("ERROR: MONGO_URI is not defined. Set it in .env or environment variables.");
  process.exit(1);
}

// Importamos Express, el framework que nos permite crear el servidor HTTP
const express = require("express");

// Importamos CORS para permitir peticiones desde otros dominios/dispositivos
const cors = require("cors");

// Importamos la función que conecta con MongoDB Atlas
const connectDB = require("./config/db");

// Importamos las rutas del módulo GPS
const gpsRoutes = require("./routes/gps");

// ── Inicialización de la app Express ────────────────────────
const app = express();

// ── Puerto del servidor ──────────────────────────────────────
const PORT = process.env.PORT || 3000;

// ── Conexión a la base de datos ──────────────────────────────
// Llamamos a la función async que establece la conexión con MongoDB
connectDB();

// ── Middlewares globales ─────────────────────────────────────
// Permite que Express entienda el body de las peticiones en formato JSON
// Sin esto, req.body estaría vacío en las peticiones POST
app.use(express.json());

// Habilita CORS para que el ESP32 u otros clientes puedan hacer peticiones
app.use(cors());

// ── Rutas ────────────────────────────────────────────────────
// Ruta raíz: simple verificación de que el servidor está activo
app.get("/", (req, res) => {
  // Respondemos con texto plano
  res.send("Argus backend active");
});

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Montamos todas las rutas GPS bajo el prefijo /api/gps
// Esto significa que /api/gps llama a las rutas definidas en routes/gps.js
app.use("/api/gps", gpsRoutes);

// ── Middleware para rutas no encontradas (404) ───────────────
// Si ninguna ruta coincide, respondemos con error 404
app.use((req, res) => {
  res.status(404).json({ message: "Ruta no encontrada" });
});

// ── Iniciar el servidor ──────────────────────────────────────
// El servidor empieza a escuchar peticiones en el puerto definido
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Argus backend running on port ${PORT}`);
});
