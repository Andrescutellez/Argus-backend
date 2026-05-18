/**
 * @fileoverview Logger estructurado en formato JSON para el sistema Argus Secure.
 *
 * PROBLEMA QUE RESUELVE:
 *   Los logs tradicionales de texto plano (console.log("Conectado: " + deviceId))
 *   son difíciles de consultar, filtrar y monitorear en producción. Cuando hay
 *   un incidente a las 3 AM, buscar en miles de líneas de texto no estructurado
 *   es lento y propenso a errores.
 *
 * SOLUCIÓN:
 *   Cada evento se emite como un objeto JSON en una sola línea. Herramientas como
 *   Google Cloud Logging, Datadog, Grafana Loki o simplemente `jq` en consola
 *   pueden filtrar, agregar y alertar sobre estos logs de forma programática:
 *
 *   $ node server.js | jq 'select(.level == "error")'
 *   $ node server.js | jq 'select(.event == "tcp.packet.accepted") | .deviceId'
 *
 * FORMATO DE SALIDA:
 *   {"ts":"2026-05-06T12:00:00.000Z","level":"info","event":"tcp.connect","remote":"203.0.113.1:54321"}
 *
 * @module tcp/logger
 */

'use strict';

/**
 * @brief Emite un evento de log estructurado en formato JSON a stdout.
 *
 * PROPÓSITO:
 *   Centralizar todos los logs del sistema TCP en un formato consistente y
 *   machine-readable. Usar stdout (console.log) en lugar de un archivo permite
 *   que el entorno de deployment (Docker, GCP Cloud Run, systemd) capture y
 *   enrute los logs a su propio sistema de agregación sin configuración adicional
 *   en la aplicación (principio de 12-factor app).
 *
 * FLUJO LÓGICO:
 *   1. Construir el objeto de entrada con timestamp ISO 8601, nivel y evento.
 *   2. Extender el objeto con los campos adicionales de 'data' (spread operator).
 *   3. Serializar a JSON y emitir por stdout con console.log().
 *
 * DEPENDENCIAS:
 *   - console.log: salida estándar del proceso Node.js.
 *   - Date: para el timestamp de cada entrada.
 *
 * POSIBLES MEJORAS (senior):
 *   1. Niveles de severidad con filtrado por LOG_LEVEL en variable de entorno:
 *      const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
 *      const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
 *      if (LEVELS[level] < MIN_LEVEL) return; // no emitir logs de nivel inferior
 *      Actualmente se emiten TODOS los logs incluyendo 'debug' (bytes crudos hex),
 *      lo que puede generar gigabytes de logs en producción con muchos devices.
 *
 *   2. Correlation IDs: agregar un requestId o sessionId por conexión TCP para
 *      poder seguir todos los eventos de un socket específico en los logs:
 *      log('info', 'tcp.connect', { remote, sessionId: crypto.randomUUID() })
 *
 *   3. Sampling de logs de debug: emitir solo 1% de los logs de nivel 'debug'
 *      para reducir volumen sin perder visibilidad en diagnóstico.
 *
 *   4. Streams dedicados: usar process.stderr para 'error' y 'warn' y process.stdout
 *      para 'info' y 'debug'. Esto permite que los sistemas de logging separen
 *      errores del flujo normal sin parsear el campo 'level'.
 *
 *   5. Integración con librerías maduras: pino, winston, o bunyan ofrecen
 *      rendimiento superior (serialización asíncrona, rotación de archivos,
 *      transports múltiples) sin mucho overhead de configuración.
 *
 * @param {'debug' | 'info' | 'warn' | 'error'} level
 *   Severidad del evento. Sigue la convención estándar de syslog:
 *   - 'debug': información de diagnóstico detallada (bytes crudos, estados internos)
 *   - 'info': eventos normales del ciclo de vida (conexión, desconexión, paquete aceptado)
 *   - 'warn': situaciones anómalas que no rompen el flujo (auth fallida, rate limit, timeout)
 *   - 'error': errores que impiden el procesamiento correcto (error de socket, fallo de BD)
 *
 * @param {string} event
 *   Identificador del evento en formato dot-notation para facilitar filtrado.
 *   Convención del proyecto: '{subsistema}.{objeto}.{accion}'
 *   Ejemplos: 'tcp.connect', 'tcp.packet.accepted', 'tcp.auth.bad_signature',
 *             'queue.flush', 'queue.flush.error', 'tcp.server.start'
 *
 * @param {Object} [data={}]
 *   Campos adicionales específicos del evento. Se mezclan con spread en el
 *   objeto de log. Evitar campos que colisionen con 'ts', 'level' o 'event'.
 *   Ejemplos de campos comunes:
 *   - remote: "IP:puerto" del cliente TCP
 *   - deviceId: identificador del ESP32
 *   - message: descripción textual de un error
 *   - count: número de elementos procesados
 *
 * @returns {void} — Función síncrona. No retorna valor útil.
 */
function log(level, event, data = {}) {
  // Construir el objeto de entrada de log.
  // El orden de las propiedades importa para legibilidad en `jq` y en la UI
  // de Cloud Logging: ts primero (para ordenar), luego level y event (para filtrar),
  // luego los campos específicos del evento.
  const entry = {
    ts: new Date().toISOString(), // Timestamp ISO 8601 con precisión de milisegundos
    level,                        // Severidad: debug | info | warn | error
    event,                        // Identificador del evento (dot-notation)
    ...data,                      // Campos específicos del evento (deviceId, remote, etc.)
  };

  // console.log() serializa a string y escribe a stdout + añade \n al final.
  // JSON.stringify() sin argumentos adicionales produce JSON compacto (sin espacios),
  // lo que minimiza el tamaño de cada línea de log.
  // Cada línea de log es un JSON completo y válido, lo que permite parsear el
  // flujo de stdout línea a línea con herramientas como `jq` o Cloud Logging.
  console.log(JSON.stringify(entry));
}

// ─── EXPORTACIONES ────────────────────────────────────────────────────────────
// Solo se exporta la función log. El diseño es intencionalmente simple:
// un solo punto de entrada para todos los logs del subsistema TCP.
module.exports = { log };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — tcp/logger.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este módulo es la "caja negra" del sistema: registra todo lo que pasa en el
   servidor TCP en un formato que las computadoras pueden leer fácilmente. En
   lugar de escribir "Error al conectar", escribe un JSON con el timestamp
   exacto, el nivel de severidad, el tipo de evento y todos los detalles
   relevantes. Esto permite que herramientas como Google Cloud Logging generen
   alertas automáticas cuando hay muchos errores, o que un desarrollador filtre
   solo los eventos de un dispositivo específico en segundos.

   PSEUDOCÓDIGO:
   log(level, event, data):
     → entry = { ts: ahora, level, event, ...data }
     → console.log(JSON.stringify(entry))
     → [stdout → capturado por Docker/GCP/systemd]

   DIAGRAMA MENTAL:
   tcpServer.js → log('warn', 'tcp.auth.bad_signature', { deviceId, remote })
                           ↓
   {"ts":"2026-05-06T...","level":"warn","event":"tcp.auth.bad_signature","deviceId":"ESP32-001","remote":"..."}
                           ↓
   stdout → [GCP Cloud Logging] → [Dashboard / Alertas]

   VARIABLES CRÍTICAS:
   - No tiene estado interno: cada llamada es independiente.
   - La única variable crítica es el objeto 'data': si contiene datos sensibles
     (contraseñas, tokens), aparecerán en los logs.

   RIESGOS DE SEGURIDAD:
   - Si 'data' contiene campos sensibles (SECRET, tokens), se exponen en los logs.
     Actualmente no se loguea SECRET directamente, pero si alguien agrega
     log('debug', 'auth', { secret: SECRET }), el secreto quedaría en los logs.
   - Sin redacción automática de datos sensibles (PII: coordenadas GPS son PII
     según GDPR si están asociadas a una persona identificable).
   - Los logs van a stdout sin cifrar: cualquier proceso con acceso al stdout
     del contenedor puede leer las coordenadas GPS en tiempo real.

   RIESGOS DE CONCURRENCIA:
   - console.log() en Node.js es síncrono para strings cortos (menor que el buffer
     del pipe, típicamente 64KB). Para strings muy largos puede volverse asíncrono
     internamente, pero en la práctica las entradas de log son siempre cortas.
   - Sin riesgos de concurrencia relevantes: función pura sin estado compartido.

   ═══════════════════════════════════════════════════════════ */
