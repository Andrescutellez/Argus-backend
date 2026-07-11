/**
 * @fileoverview Punto de entrada principal del backend Argus Secure.
 *
 * Este archivo es el corazón del sistema. Levanta simultáneamente tres
 * capas de comunicación:
 *   1. Un servidor HTTP/REST (Express 5) para la API web.
 *   2. Un servidor WebSocket (Socket.io) para push en tiempo real a clientes.
 *   3. Un servidor TCP crudo para recibir paquetes del hardware ESP32.
 *
 * También activa el worker de la cola de escritura a MongoDB para que
 * los datos GPS se persistan en batches de forma no bloqueante.
 *
 * @module server
 */

'use strict';

// ─── 1. CARGA DE VARIABLES DE ENTORNO ────────────────────────────────────────
// dotenv lee el archivo .env en la raíz del proyecto e inyecta cada par
// KEY=VALUE como propiedad de process.env. DEBE ejecutarse ANTES de cualquier
// otro require() que consuma variables de entorno, de lo contrario esos módulos
// verían undefined en sus constantes de módulo.
require('dotenv').config();

// Guard de arranque: si MONGO_URI no está definida no tiene sentido continuar.
// process.exit(1) corta aquí con código de error no-cero, lo que hace que
// systemd / Docker / GCP Cloud Run reinicien el contenedor o marquen el pod
// como CrashLoopBackOff. Sin este guard el servidor arrancaría, pero cada
// request a la BD generaría un UnhandledPromiseRejection silencioso.
if (!process.env.MONGO_URI) {
  console.error('ERROR: MONGO_URI is not defined. Set it in .env or environment variables.');
  process.exit(1);
}

// ─── 2. DEPENDENCIAS DEL FRAMEWORK ───────────────────────────────────────────
const http = require('http');      // Módulo nativo: crea el servidor HTTP subyacente
const express = require('express'); // Framework de routing y middleware HTTP
const cors = require('cors');       // Middleware que agrega cabeceras CORS a cada respuesta
const { Server } = require('socket.io'); // Capa WebSocket sobre el server HTTP
const jwt        = require('jsonwebtoken'); // Verificación de tokens JWT en el handshake WebSocket

// ─── 3. MÓDULOS INTERNOS ──────────────────────────────────────────────────────
const connectDB = require('./config/db');              // Establece la conexión a MongoDB Atlas
const { initPostgres } = require('./config/postgres'); // Pool y schema PostgreSQL
const { initFirebase } = require('./config/firebase'); // Firebase Admin SDK (push notifications)
const gpsRoutes = require('./routes/gps');             // Rutas REST para datos GPS
const deviceRoutes = require('./routes/device');       // Rutas REST para gestión de dispositivos
const alertRoutes = require('./routes/alert');         // Rutas REST para historial de alertas
const authRoutes  = require('./routes/auth');            // Rutas REST de autenticación JWT
const motoRoutes  = require('./routes/moto');            // Rutas REST para motos
const auditRoutes = require('./routes/audit');           // Rutas REST para audit log
const subscriptionRoutes      = require('./routes/subscription');  // Rutas REST para suscripciones
const fleetRoutes             = require('./routes/fleet');          // Rutas REST para flota (operador)
const manufacturedRoutes      = require('./routes/manufactured');   // Rutas REST para catálogo de MACs
const gisRoutes               = require('./routes/gis');             // Rutas REST GIS — lookup, near, heatmap
const weatherRoutes           = require('./routes/weather');          // Rutas REST weather — lluvia SAB
const driveRoutes             = require('./routes/drive');             // Rutas REST conducción — métricas MPU6050
const crimeRoutes             = require('./routes/crime');             // Rutas REST criminalidad — hurtos motos/autos por localidad
const geofenceRoutes          = require('./routes/geofence');           // Rutas REST geocercas de estacionamiento
const incidentRoutes          = require('./routes/incident');            // Rutas REST incidentes comunitarios
const otaRoutes               = require('./routes/ota');                  // Rutas REST OTA firmware
const secureRoomRoutes        = require('./routes/secureRoom');          // Rutas REST sala de recuperación Argus Secure
const settingsRoutes          = require('./routes/settings');             // Rutas REST configuración global
const { initGeoStream }       = require('./services/geoStreamService'); // WebSocket GPS para Argus Secure
const { warmCache: warmCrimeCache } = require('./controllers/crimeController'); // Pre-carga ARI cache
const { warmGeofenceCache } = require('./tcp/geofenceMonitor');                  // Pre-carga geocercas activas
const { startTcpServer, startTlsServer } = require('./tcp/tcpServer'); // Servidores TCP/TLS para ESP32
const { setIo } = require('./services/socketService'); // Singleton io para controllers
const { startWorker } = require('./tcp/queue');        // Worker que escribe batches a MongoDB

// ─── 4. CREACIÓN DEL SERVIDOR HTTP + EXPRESS ──────────────────────────────────
// Se crea primero un http.Server nativo y luego Express se monta sobre él.
// Esto es necesario porque Socket.io necesita adjuntarse al servidor HTTP
// subyacente, no a la app de Express directamente. Si se usara app.listen()
// no habría forma de pasarle ese servidor a Socket.io.
const app = express();

// trust proxy = 1: Express confía en el PRIMER proxy de la cadena (nginx en
// esta misma VM). Necesario desde la migración 2026-07-09: nginx agrega
// X-Forwarded-For, y sin esto express-rate-limit lanza
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR en cada request y el rate limiting de
// comandos falla. Además req.ip pasa a ser la IP real del cliente (no la de
// nginx), que es lo que el rate limiter debe usar como llave.
// Valor 1 (no true): confiar en exactamente un salto — un cliente malicioso
// no puede falsificar su IP inyectando su propio X-Forwarded-For.
app.set('trust proxy', 1);

const httpServer = http.createServer(app);

// ⚠️ initGeoStream DEBE registrar su listener 'upgrade' ANTES que socket.io.
// engine.io v6 intercepta y destruye TODOS los upgrades que no sean /socket.io/,
// por lo que si socket.io se inicializa primero, los upgrades a /geo llegan con
// 400 Bad Request antes de que geoStreamService pueda manejarlos.
initGeoStream(httpServer);

// ─── 5. SOCKET.IO ─────────────────────────────────────────────────────────────
/**
 * Instancia global de Socket.io compartida con el servidor TCP.
 *
 * PROPÓSITO:
 *   Permite que cuando el servidor TCP recibe una posición GPS del ESP32,
 *   la emita inmediatamente a todos los clientes web/app conectados por
 *   WebSocket sin pasar por HTTP. Esto da latencia <50ms en lugar de
 *   requerir polling cada N segundos.
 *
 * CORS { origin: '*' }:
 *   En producción esto debería restringirse al dominio del frontend.
 *   Actualmente acepta conexiones WebSocket desde cualquier origen,
 *   lo cual es un riesgo si el servidor fuera accesible públicamente
 *   sin autenticación adicional en el handshake de Socket.io.
 *
 * ARQUITECTURA ⚠️: origin: '*' en producción
 *   CÓMO LO HARÍA UN SENIOR: origin: ['https://app.argus.com'] con
 *   validación de token en el middleware de conexión de Socket.io.
 *   IMPACTO ACTUAL: cualquier página web puede establecer una conexión
 *   WebSocket y recibir las coordenadas GPS en tiempo real de todos
 *   los dispositivos sin autenticación.
 */
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

// ─── AUTENTICACIÓN SOCKET.IO ─────────────────────────────────────────────────
// io.use() se ejecuta en el handshake inicial antes de que el socket se establezca.
// Si next(Error) se llama, el cliente recibe 'connect_error' y no puede recibir eventos.
// El token viaja en socket.handshake.auth.token (opción 'auth' de socket.io-client).
// No usamos query params para el token porque quedarían en logs de nginx.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('unauthorized'));
  try {
    socket.data.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return next(new Error('unauthorized'));
  }
});

// Registrar io en el singleton para que controllers REST puedan emitir
setIo(io);

// Cuando un agente de reacción conecta por socket.io, se une al room 'reaction'
// para recibir 'incident:new' y 'incident:resolved' en tiempo real.
// Los usuarios normales se unen al room de su deviceId (ya manejado en tcpServer).
io.on('connection', (socket) => {
  // Rol viene del JWT verificado, no del query param (que cualquiera puede falsificar).
  const role     = socket.data.user?.role;
  const deviceId = socket.handshake.query?.deviceId;

  if (role === 'REACTION') {
    socket.join('reaction');
  }

  // Une el socket al room de su dispositivo para recibir eventos dirigidos:
  // 'secure:room_alert' (sala de recuperación) e 'incident:nearby' (robo cercano).
  if (deviceId) {
    socket.join(`device:${deviceId}`);
  }

  // El cliente puede unirse al room de un incidente específico para recibir
  // updates de GPS en tiempo real mientras persigue la moto.
  socket.on('incident:join', (incidentId) => {
    if (incidentId) socket.join(`incident:${incidentId}`);
  });

  socket.on('incident:leave', (incidentId) => {
    if (incidentId) socket.leave(`incident:${incidentId}`);
  });
});

// ─── 6. PUERTO HTTP ───────────────────────────────────────────────────────────
// process.env.PORT lo inyecta GCP Cloud Run / Heroku / Railway automáticamente.
// El fallback a 3000 garantiza que el entorno de desarrollo local funcione
// sin configuración extra. El servidor TCP usa su propio puerto (TCP_PORT en .env).
const PORT = process.env.PORT || 3000;

// ─── 7. INICIALIZACIÓN DE SERVICIOS ──────────────────────────────────────────

// Conecta a MongoDB (lazy — Mongoose encola queries hasta conectar).
connectDB();

// Inicializa PostgreSQL: crea el pool y el schema (users, user_devices).
// Es async pero el servidor puede arrancar en paralelo; los endpoints de auth
// no estarán disponibles hasta que la promesa se resuelva (~100ms en LAN).
initPostgres();

// Inicializa Firebase Admin SDK para push notifications.
// Si falta config/firebase-service-account.json, queda desactivado sin romper el servidor.
initFirebase();

// Arranca el worker que drena la cola en memoria hacia MongoDB cada 2 segundos.
// Si esto no se llama, los datos GPS se acumularán en el array queue[] de
// tcp/queue.js pero nunca se escribirán a la base de datos (pérdida silenciosa).
startWorker();

// Levanta el servidor TCP en TCP_PORT (por defecto 80 según tcpServer.js).
// Le pasamos io para que el servidor TCP pueda emitir eventos WebSocket
// directamente cuando recibe un paquete GPS válido del ESP32.
startTcpServer(io);

// Levanta el servidor TLS en TCP_TLS_PORT (9001 por defecto) — canal cifrado paralelo.
// Si los certificados no existen en certs/, se omite sin crashear y solo queda el TCP plano.
// Rollback: flashear firmware con TCP_USE_TLS=0 → vuelve a conectar por el puerto 9000.
startTlsServer(io);

// Pre-carga el cache de criminalidad para que riskMonitor.js pueda calcular
// ARI desde el primer paquete GPS, sin esperar a que alguien abra la web.
// El delay de 8s da margen para que MongoDB y la conexión a OAIEE estén listos.
setTimeout(() => warmCrimeCache(), 8000);

// Pre-carga geocercas activas desde PostgreSQL al cache en memoria.
// geofenceMonitor.js usa ese cache por GPS frame — sin este warm-up, la primera
// evaluación post-reinicio de servidor haría una query a PG (lento) o peor, no
// detectaría salidas de zona si el servidor reiniició mientras la moto estaba estacionada.
setTimeout(() => warmGeofenceCache(), 3000);

// ─── 8. MIDDLEWARE GLOBAL DE EXPRESS ─────────────────────────────────────────

// express.json() parsea el body de requests con Content-Type: application/json.
// Sin este middleware, req.body sería undefined en todos los handlers POST/PUT.
// Limit por defecto: 100kb — suficiente para comandos de dispositivo.
app.use(express.json());

// cors() agrega las cabeceras Access-Control-Allow-* a todas las respuestas.
// Esto permite que el frontend en otro dominio/puerto haga fetch() a esta API.
// ARQUITECTURA ⚠️: sin configuración de origen específico
//   CÓMO LO HARÍA UN SENIOR: cors({ origin: process.env.CORS_ORIGIN, credentials: true })
//   IMPACTO ACTUAL: cualquier dominio puede hacer requests a la API REST.
app.use(cors());

// ─── 9. RUTAS DE SALUD ────────────────────────────────────────────────────────

// Ruta raíz: útil para confirmar rápidamente que el proceso está vivo.
// No debe contener lógica de negocio.
app.get('/', (req, res) => res.send('Argus backend active'));

/**
 * Health check endpoint.
 *
 * PROPÓSITO:
 *   Los load balancers de GCP (y herramientas como Kubernetes / Cloud Run)
 *   hacen GET /health periódicamente. Si responde 200, el pod/instancia
 *   se considera sano. Si falla, el tráfico se redirige a otra instancia.
 *
 * MEJORA RECOMENDADA:
 *   Incluir estado real de MongoDB y del servidor TCP en la respuesta:
 *   { status: 'ok', db: 'connected', tcp: 'listening', uptime: process.uptime() }
 */
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

// ─── 10. MONTAJE DE RUTAS DE NEGOCIO ─────────────────────────────────────────

// Todas las rutas de datos GPS quedan bajo /api/gps.
// Ver routes/gps.js para el detalle de cada endpoint.
app.use('/api/auth',   authRoutes);
app.use('/api/gps',    gpsRoutes);
app.use('/api/device', deviceRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/motos',         motoRoutes);
app.use('/api/audit',         auditRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/fleet',         fleetRoutes);
app.use('/api/manufactured',  manufacturedRoutes);
app.use('/api/gis',           gisRoutes);
app.use('/api/weather',       weatherRoutes);
app.use('/api/drive',         driveRoutes);
app.use('/api/crime',         crimeRoutes);
app.use('/api/geofence',      geofenceRoutes);
app.use('/api/incidents',     incidentRoutes);
app.use('/api/secure/rooms', secureRoomRoutes);
app.use('/api/settings',     settingsRoutes);
app.use('/api/ota',          otaRoutes);

// ─── 11. MANEJADOR 404 CATCH-ALL ──────────────────────────────────────────────
// En Express 5 los middlewares de error deben registrarse después de todas
// las rutas. Este middleware captura cualquier ruta no definida arriba.
// Si se registrara antes de las rutas, interceptaría todas las requests.
app.use((req, res) => {
  res.status(404).json({ message: 'Ruta no encontrada' });
});

// ─── 12. INICIO DEL SERVIDOR HTTP ─────────────────────────────────────────────
// '0.0.0.0' hace que el servidor escuche en todas las interfaces de red,
// incluyendo la interfaz externa de la VM de GCP. Si se usara 'localhost'
// o '127.0.0.1', el servidor solo sería accesible desde la propia máquina
// y nginx / el load balancer no podría llegar a él.
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Argus backend running on port ${PORT}`);
});

// ─── 13. EXPORTACIÓN ──────────────────────────────────────────────────────────
// Se exporta io para que otros módulos (tests de integración, futuros
// módulos de alertas) puedan emitir eventos WebSocket sin reimportar socket.io.
// En los tests esto permite hacer io.emit() directamente sin levantar un cliente.
module.exports = { io };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — server.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este archivo es el punto de arranque de todo el sistema Argus. Cuando
   ejecutas "node server.js", él se encarga de conectar la base de datos,
   levantar el servidor web que atiende la aplicación del usuario, levantar
   el canal WebSocket que envía posiciones en tiempo real al teléfono, y
   levantar el servidor TCP que escucha al dispositivo GPS instalado en la
   moto. Es como un director de orquesta que levanta todos los músicos
   antes de que empiece el concierto.

   PSEUDOCÓDIGO:
   1. Cargar variables de entorno desde .env
   2. Verificar que MONGO_URI existe o abortar
   3. Crear app Express + servidor HTTP subyacente
   4. Montar Socket.io sobre el servidor HTTP
   5. Conectar MongoDB (async, no bloqueante)
   6. Arrancar worker de cola de escritura GPS
   7. Arrancar servidor TCP para el ESP32
   8. Registrar middleware: JSON parser, CORS
   9. Montar rutas REST: /api/gps, /api/device
   10. Catch-all 404
   11. Escuchar en PORT en todas las interfaces

   DIAGRAMA MENTAL:
   Internet/App → [HTTP:PORT] → Express → Routes → Controllers → MongoDB
   ESP32        → [TCP:TCP_PORT] → tcpServer → queue → MongoDB
   tcpServer    → [Socket.io] → Clientes web en tiempo real

   VARIABLES CRÍTICAS:
   - io: instancia de Socket.io — si se corrompe, el push en tiempo real muere
   - PORT: si difiere del que espera GCP Cloud Run, el health check falla y el servicio no arranca
   - MONGO_URI: sin ella el proceso termina inmediatamente

   RIESGOS DE SEGURIDAD:
   - CORS con origin:'*' permite que cualquier página web acceda a la API
   - Socket.io: autenticación JWT implementada via io.use() — resuelto 2026-07-04
   - Rate limiting en POST /api/device/:id/command (10/min) — resuelto 2026-07-04

   RIESGOS DE CONCURRENCIA:
   - connectDB() es async pero se llama sin await; en un arranque muy rápido
     la primera request HTTP podría llegar antes de que Mongoose esté listo
     (en la práctica Mongoose encola las queries hasta conectar, así que es seguro)
   - El worker de cola usa setInterval: si flush() tarda más de FLUSH_INTERVAL_MS
     pueden solaparse dos ejecuciones y procesar el mismo item (ver tcp/queue.js)

   ═══════════════════════════════════════════════════════════ */

/* ARQUITECTURA GENERAL:
   Argus Backend es un monolito modular con tres capas de entrada:
   HTTP (REST), WebSocket (tiempo real) y TCP (hardware IoT). La capa
   TCP es el core del sistema: recibe datos del ESP32, los encola en
   memoria y los persiste en batches a MongoDB para minimizar latencia
   de respuesta al hardware. La capa REST sirve al frontend para consultar
   historial y enviar comandos. La capa WebSocket notifica al frontend
   de cada nueva posición sin que el cliente tenga que hacer polling.
*/

/* MAPA DE MÓDULOS:
   server.js
   ├── config/db.js          → Conexión MongoDB Atlas via Mongoose
   ├── routes/gps.js         → POST /api/gps, GET /api/gps, GET /api/gps/:id/latest
   │   └── controllers/gpsController.js
   │       └── models/Gps.js
   ├── routes/device.js      → GET /api/device/:id/status, POST /api/device/:id/command
   │   └── controllers/deviceController.js
   │       └── tcp/tcpServer.js (connectedDevices, sendCommand)
   └── tcp/
       ├── tcpServer.js      → net.createServer, parsePacket, flushCommands, sendCommand
       │   ├── tcp/deviceAuth.js  → isAllowed, verifySignature (CRC32)
       │   ├── tcp/queue.js       → enqueue, flush batch a MongoDB
       │   └── tcp/logger.js      → log estructurado JSON
       └── queue.js          → worker setInterval que drena la queue
*/

/* FLUJO COMPLETO DE UN PAQUETE GPS:
   1. ESP32 abre socket TCP a GCP:TCP_PORT
   2. ESP32 envía: "ARGUS|ESP32-001|1700000000000|19.432|−99.133|A1B2C3D4\n"
   3. tcpServer.js recibe el chunk, lo agrega al buffer
   4. Cuando encuentra \n, parsea la línea con parsePacket()
   5. Verifica device en whitelist (isAllowed)
   6. Verifica firma CRC32 (verifySignature)
   7. Verifica rate limit (mínimo 5s entre paquetes)
   8. Encola el dato en memoria (enqueue)
   9. Emite socket.io 'gps:update' al frontend
   10. Responde ACK\r\n al ESP32
   11. Envía comandos pendientes (flushCommands)
   12. Cada 2s: queue.js hace insertMany() en MongoDB
*/

/* MEJORAS RECOMENDADAS:
   1. ✅ Autenticación en Socket.io: io.use() con JWT implementado 2026-07-04.
   2. CORS restrictivo: reemplazar origin:'*' por lista de dominios en .env.
   3. ✅ Rate limiting HTTP: express-rate-limit en POST /api/device/command (2026-07-04).
   4. Helmet.js: cabeceras de seguridad HTTP (X-Frame-Options, CSP, etc.).
   5. Graceful shutdown: manejar SIGTERM para drenar la cola antes de salir
      y evitar pérdida de datos GPS en cola cuando Cloud Run rota instancias.
   6. Health check profundo: verificar estado real de MongoDB y TCP en /health.
   7. Structured logging HTTP: morgan con formato JSON para que los logs del
      API sean igual de consultables que los logs del servidor TCP.
*/

/* DEUDA TÉCNICA:
   - Sin autenticación en endpoints REST (ningún endpoint requiere token)
   - Sin paginación configurable en GET /api/gps (hardcodeado limit:100)
   - Sin validación de esquema en entrada REST más allá del controlador
   - Sin manejo de SIGTERM / graceful shutdown
   - Sin compresión HTTP (sin compression middleware)
   - Sin helmet para cabeceras de seguridad
*/
