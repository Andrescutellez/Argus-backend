# Argus Backend

## Segundo cerebro
Bóveda Obsidian: `C:\Users\Leonardo\Desktop\Proyecto Argus\Boveda Obsidian\Argus\`
Al retomar una sesión, leer: `_Claude/SEGUNDO_CEREBRO.md` → `_Claude/Pendientes Claude.md` → `_Claude/Contexto Argus.md`

## Stack
- **Runtime:** Node.js con Express 5
- **Base de datos:** MongoDB via Mongoose
- **Protocolo IoT:** TCP directo (servidor propio en `tcp/tcpServer.js`)
- **Entrada:** `node server.js` / `node --watch server.js`

## Estructura del proyecto

```
server.js              ← entry point, monta Express + TCP server
config/db.js           ← conexión MongoDB
routes/gps.js          ← rutas REST
controllers/
  gpsController.js     ← lógica de ingestión GPS
models/
  Gps.js               ← schema Mongoose
tcp/
  tcpServer.js         ← servidor TCP para conexiones ESP32
  deviceAuth.js        ← autenticación de dispositivos
  queue.js             ← cola de mensajes TCP
  logger.js            ← logging de eventos TCP
```

## Notas relevantes en la bóveda

| Tema | Nota |
|------|------|
| Arquitectura del backend | `05-Platform/Backend Argus — Resumen.md` |
| Colas y eventos | `05-Platform/Backend Architecture — Events & Queues.md` |
| Web app y RBAC | `05-Platform/Platform Web & Roles.md` |
| Protocolo TCP con ESP32 | `04-Comm-Protocols/Case Study - HTTP→TCP.md` |
| Diagnóstico de conectividad | `04-Comm-Protocols/Connectivity — Transport & Diagnostics.md` |
| Infra GCP y nginx | `04-Comm-Protocols/Infrastructure & Cloud Integration.md` |
| Formato del payload recibido | `01-Architecture/Protocolo Argus (frame).md` |

## Convenciones de código
- Nombres de variables en camelCase, constantes en UPPER_SNAKE_CASE.
- Endpoints REST: `POST /api/gps`, `POST /api/events`.
- Puerto TCP: comunicación con ESP32 via `tcp/tcpServer.js`.
- Variables de entorno en `.env` (ver `.env.example`).

## Contexto crítico
- El ESP32 se conecta via TCP directo (no HTTP). Ver `tcp/tcpServer.js`.
- El payload que llega del ESP32 sigue el Protocolo Argus frame (binario/JSON).
- MongoDB almacena los datos GPS con schema en `models/Gps.js`.
