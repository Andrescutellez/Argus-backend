/**
 * @fileoverview Cola de escritura en memoria para persistencia eficiente de datos GPS en MongoDB.
 *
 * PROBLEMA QUE RESUELVE:
 *   El ESP32 espera un ACK del servidor TCP en menos de ~1 segundo. Si se hiciera
 *   un await Gps.save() por cada paquete, la latencia de MongoDB (~50-500ms en
 *   Atlas free tier) bloquearía el event loop durante ese tiempo y el ACK llegaría
 *   tarde, causando que el módulo SIM marque la transmisión como fallida y reintente.
 *
 * SOLUCIÓN IMPLEMENTADA:
 *   Buffer in-memory (array JS) + worker con setInterval que escribe batches cada
 *   FLUSH_INTERVAL_MS usando insertMany(). Esto desacopla la velocidad de respuesta
 *   TCP de la velocidad de escritura en BD: el ACK se envía en microsegundos,
 *   y MongoDB recibe los datos en el siguiente flush (máximo 2 segundos después).
 *
 * TRADE-OFF:
 *   Si el proceso Node.js cae (SIGKILL, OOM, crash) entre dos flushes, los datos
 *   en el array queue[] se pierden. Para telemetría GPS con envíos cada 30 segundos
 *   y flushes cada 2 segundos, la ventana de pérdida máxima es de 2 segundos de datos,
 *   que en el peor caso es un único punto GPS (menos de 0.1% de los datos).
 *
 * @module tcp/queue
 */

'use strict';

const Gps = require('../models/Gps'); // Modelo Mongoose para la colección 'gps' en MongoDB
const { log } = require('./logger');  // Logger estructurado JSON

// ─── ESTADO DE LA COLA ────────────────────────────────────────────────────────

/**
 * Array in-memory que actúa como buffer entre la recepción TCP y la escritura en MongoDB.
 *
 * @type {Array<{ deviceId: string, lat: number, lon: number, timestamp: Date }>}
 *
 * RIESGO DE CONCURRENCIA:
 *   Node.js es single-threaded, así que no hay race conditions entre push() y splice().
 *   Sin embargo, si flush() es llamado simultáneamente por dos setInterval (imposible
 *   en Node.js normal pero posible en tests mal escritos), el splice() del segundo
 *   verá la cola ya vacía y no hará nada (el check queue.length === 0 protege esto).
 *
 * RIESGO DE MEMORIA:
 *   Si MongoDB está caído y los flushes fallan, los datos no se eliminan de la cola
 *   (porque batch = queue.splice() ya los extrajo ANTES de intentar la escritura).
 *   Esto significa que si la BD cae, los datos SE PIERDEN (no se reinsertan en la cola
 *   al fallar). Ver comentario en flush() sobre este comportamiento.
 */
const queue = [];

/**
 * Intervalo en milisegundos entre cada ejecución del worker de flush.
 *
 * 2000ms es un balance entre:
 * - Latencia de persistencia: máximo 2s entre que el dato llega y se guarda en MongoDB.
 * - Eficiencia de escritura: agrupa todos los datos de 2 segundos en una sola operación.
 * - Carga en MongoDB: reduce el número de operaciones de 1 por paquete a ~1 por 2 segundos.
 *
 * Con dispositivos enviando cada 30s y flushes cada 2s, cada batch tendrá típicamente
 * 1-3 documentos. La ventaja del batch se vuelve más significativa con docenas de devices.
 */
const FLUSH_INTERVAL_MS = 2000;

/**
 * Número máximo de documentos a escribir en un solo insertMany().
 *
 * Limitar el batch size previene que un spike de tráfico genere una operación
 * de inserción masiva que bloquee MongoDB por varios segundos. Si hay más de
 * BATCH_SIZE documentos en la cola, el siguiente flush procesará el resto.
 *
 * Con 50 documentos de ~200 bytes cada uno, un batch pesa ~10KB.
 * insertMany() en MongoDB Atlas es eficiente hasta varios miles de documentos,
 * así que 50 es conservador pero suficiente para el volumen esperado.
 */
const BATCH_SIZE = 50;

// ─── WORKER DE PERSISTENCIA ───────────────────────────────────────────────────

/**
 * @brief Extrae hasta BATCH_SIZE elementos de la cola y los persiste en MongoDB.
 *
 * PROPÓSITO:
 *   Drenar el buffer in-memory hacia MongoDB de forma eficiente usando insertMany().
 *   insertMany() es significativamente más rápido que múltiples save() individuales
 *   porque agrupa las inserciones en una sola operación de red con el servidor MongoDB.
 *
 * FLUJO LÓGICO:
 *   1. Si la cola está vacía, retornar inmediatamente (no gastar una roundtrip a MongoDB).
 *   2. Extraer hasta BATCH_SIZE elementos con splice(0, BATCH_SIZE).
 *      splice() muta el array original, eliminando los elementos extraídos.
 *   3. Llamar insertMany() con { ordered: false } para inserción no ordenada.
 *   4. Si tiene éxito, loguear la cantidad de documentos escritos.
 *   5. Si falla, loguear el error y la cantidad de documentos perdidos.
 *
 * DEPENDENCIAS:
 *   - queue: array global de este módulo.
 *   - Gps: modelo Mongoose que mapea a la colección 'gps' en MongoDB.
 *   - log: logger estructurado.
 *
 * POSIBLES MEJORAS (senior):
 *   - En caso de error de MongoDB, reinsertar el batch al frente de la cola
 *     (queue.unshift(...batch)) para no perder datos. Actualmente se pierden.
 *   - Implementar backoff exponencial: si insertMany() falla, aumentar el intervalo
 *     de flush temporalmente para dar tiempo a MongoDB de recuperarse.
 *   - Agregar una métrica de "documentos perdidos por flush fallido" para alertar
 *     cuando la tasa de pérdida supere un umbral.
 *   - Limitar el tamaño máximo de queue[]: si supera N elementos (MongoDB caído
 *     por mucho tiempo), implementar drop policy para evitar OOM.
 *
 * @returns {Promise<void>} — Resuelve cuando la operación de BD termina (o si la cola estaba vacía).
 * @throws No lanza excepciones; los errores son capturados y logueados internamente.
 */
async function flush() {
  // Verificación de cola vacía: evita hacer un roundtrip a MongoDB innecesario.
  // Con FLUSH_INTERVAL_MS=2000 y paquetes cada 30s, la mayoría de los flushes
  // son no-ops (la cola está vacía). Este check es crítico para la eficiencia.
  if (queue.length === 0) return;

  // splice(0, BATCH_SIZE) extrae los primeros BATCH_SIZE elementos y los elimina
  // del array original en una operación atómica (single-threaded en Node.js).
  // Los elementos extraídos ya NO están en queue[], lo que significa que si
  // insertMany() falla a continuación, esos datos se perderán.
  // ARQUITECTURA ⚠️: no hay recuperación si insertMany() falla
  //   CÓMO LO HARÍA UN SENIOR: const batch = queue.slice(0, BATCH_SIZE) primero,
  //   y solo hacer queue.splice(0, batch.length) si insertMany() tiene éxito.
  //   IMPACTO ACTUAL: si MongoDB está inaccesible, se pierden hasta 50 registros GPS por flush.
  const batch = queue.splice(0, BATCH_SIZE);

  try {
    // insertMany() inserta todos los documentos del batch en una sola operación.
    // { ordered: false } le dice a MongoDB que continue insertando aunque algún
    // documento falle (ej: por duplicado de _id). Sin esto, si el primer documento
    // falla, todos los siguientes serían ignorados.
    // En este caso todos los documentos son nuevos (generamos _id automáticamente),
    // así que ordered:false principalmente ayuda con errores de validación de schema
    // en documentos individuales corruptos.
    await Gps.insertMany(batch, { ordered: false });
    log('info', 'queue.flush', { count: batch.length });
  } catch (err) {
    // Error de MongoDB: conexión caída, timeout, error de validación masivo, etc.
    // Los datos del batch ya fueron extraídos de queue[] y ahora están perdidos.
    // Logueamos 'dropped' para que el monitoreo detecte pérdida de datos.
    log('error', 'queue.flush.error', { message: err.message, dropped: batch.length });
  }
}

// ─── API PÚBLICA ──────────────────────────────────────────────────────────────

/**
 * @brief Agrega un dato GPS a la cola en memoria para persistencia diferida.
 *
 * PROPÓSITO:
 *   Desacoplar la recepción del paquete TCP (que necesita respuesta inmediata)
 *   de la escritura en MongoDB (que puede tomar decenas a cientos de milisegundos).
 *   enqueue() es síncrono y completa en O(1), permitiendo que tcpServer.js
 *   responda el ACK al ESP32 inmediatamente después.
 *
 * FLUJO LÓGICO:
 *   1. Push del objeto de dato al final del array queue[].
 *   2. Retornar (sin await, sin callback).
 *
 * DEPENDENCIAS:
 *   - queue: array global de este módulo.
 *
 * POSIBLES MEJORAS (senior):
 *   - Implementar un límite máximo de la cola (ej: 10.000 elementos) y aplicar
 *     una política de rechazo (drop oldest o drop newest) si se supera, para
 *     evitar que un MongoDB caído por horas consuma toda la RAM del proceso.
 *   - Retornar la longitud actual de la cola para que el caller pueda monitorear
 *     si la cola está creciendo más rápido de lo que se puede drenar.
 *
 * @param {{ deviceId: string, lat: number, lon: number, timestamp: Date }} data
 *   El objeto de dato GPS tal como llega de tcpServer.js después de la validación.
 *   - deviceId: identificador del ESP32 (ej: "ESP32-001")
 *   - lat: latitud validada (entre -90 y 90)
 *   - lon: longitud validada (entre -180 y 180). Nota: el campo en el schema Mongoose es 'lon'
 *   - timestamp: objeto Date del momento de recepción del paquete
 * @returns {void} — Función síncrona, no retorna valor útil.
 */
function enqueue(data) {
  // Array.push() en V8 es O(1) amortizado. No bloquea el event loop.
  // El objeto 'data' es una referencia; el array almacena la referencia, no una copia.
  // Dado que 'data' no se modifica después de enqueue(), esto es seguro.
  queue.push(data);
}

/**
 * @brief Inicia el worker periódico que drena la cola hacia MongoDB.
 *
 * PROPÓSITO:
 *   Arrancar el ciclo de vida del sistema de cola. Debe llamarse UNA SOLA VEZ
 *   al iniciar el servidor (desde server.js). Llamarlo múltiples veces crearía
 *   múltiples setIntervals compitiendo por la misma cola.
 *
 * FLUJO LÓGICO:
 *   1. Registrar setInterval con flush() y FLUSH_INTERVAL_MS.
 *   2. Loguear que el worker está activo.
 *
 * DEPENDENCIAS:
 *   - flush(): función de este módulo.
 *   - FLUSH_INTERVAL_MS: constante del módulo.
 *   - log: logger estructurado.
 *
 * POSIBLES MEJORAS (senior):
 *   - Retornar el intervalId para poder hacer clearInterval() en un graceful shutdown.
 *     Actualmente si el proceso recibe SIGTERM, el setInterval puede ejecutarse
 *     una vez más mientras el proceso está terminando, con Mongoose en estado de cierre.
 *   - Implementar "flush on shutdown": al recibir SIGTERM, llamar flush() una vez más
 *     antes de cerrar la conexión MongoDB para no perder los datos en cola.
 *
 * @returns {void} — No retorna el intervalId, lo que impide detener el worker externamente.
 */
function startWorker() {
  // setInterval registra flush() para ejecutarse cada FLUSH_INTERVAL_MS milisegundos.
  // flush() es async pero setInterval no espera a que el Promise resuelva antes de
  // programar la siguiente ejecución. Si flush() tarda más de FLUSH_INTERVAL_MS
  // (MongoDB muy lento), dos ejecuciones de flush() podrían solaparse.
  // En la práctica esto es seguro porque la primera extrajo sus datos con splice()
  // y la segunda verá la cola desde donde quedó, sin duplicados.
  setInterval(flush, FLUSH_INTERVAL_MS);
  log('info', 'queue.worker.start', { intervalMs: FLUSH_INTERVAL_MS });
}

// ─── EXPORTACIONES ────────────────────────────────────────────────────────────
// Solo se exporta la API pública. queue[] y flush() son internos del módulo.
// Esto encapsula la implementación y permite cambiarla (ej: usar Redis) sin
// que tcpServer.js o server.js tengan que cambiar.
module.exports = { enqueue, startWorker };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — tcp/queue.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Imagina que el ESP32 es un repartidor de pizza que toca el timbre y espera
   que le abras la puerta rápidamente. Si tardas mucho (porque estás haciendo
   una llamada larga = escribiendo en MongoDB), el repartidor se va molesto.
   Este módulo es como poner una canasta en la puerta: el repartidor deja la
   pizza en la canasta (enqueue) y se va enseguida. Tú revisas la canasta cada
   2 segundos (setInterval + flush), tomas todo lo que hay (batch) y lo guardas
   en el refrigerador (MongoDB). Si el refrigerador está averiado cuando revisas,
   las pizzas de ese momento se pierden, pero las siguientes están a salvo.

   PSEUDOCÓDIGO:
   enqueue(dato):
     → queue.push(dato)   ← instantáneo, no bloquea

   flush() [cada 2 segundos]:
     → si queue vacía → salir
     → batch = queue.splice(0, 50)   ← extrae y elimina hasta 50 items
     → await Gps.insertMany(batch)
     → si error → loguear pérdida (datos ya extraídos, no se recuperan)

   startWorker():
     → setInterval(flush, 2000)

   DIAGRAMA MENTAL:
   tcpServer.js
       ↓ enqueue(dato)
   [queue: Array in-memory] ← acumulación continua
       ↓ cada 2s (setInterval)
   flush() → insertMany(batch) → MongoDB Atlas
       ↓ si falla → log error + datos perdidos

   VARIABLES CRÍTICAS:
   - queue[]: si crece sin control (MongoDB caído) puede agotar la RAM del proceso
   - FLUSH_INTERVAL_MS: si es muy largo, aumenta la latencia de persistencia y el tamaño del batch
   - BATCH_SIZE: si es muy grande, una sola insertMany() puede tardar demasiado y bloquear MongoDB

   RIESGOS DE SEGURIDAD:
   - Sin límite en el tamaño de queue[]: un atacante que flood-ee el servidor TCP
     con paquetes válidos (conociendo deviceId y secreto) podría agotar la RAM.
   - Los datos en queue[] no están cifrados en memoria: en un sistema multiusuario,
     un proceso con acceso al heap podría leer las coordenadas GPS de otros usuarios.

   RIESGOS DE CONCURRENCIA:
   - Node.js es single-threaded: push() y splice() son atómicos desde la perspectiva
     del event loop. No hay race conditions reales.
   - Si flush() es async y tarda más de FLUSH_INTERVAL_MS, dos ejecuciones de flush()
     pueden estar "activas" simultáneamente (una esperando el await de MongoDB, la otra
     iniciando). Cada una opera sobre diferentes elementos (ya extraídos con splice()),
     así que no hay duplicados ni pérdidas adicionales.
   - Con cluster mode (múltiples procesos Node.js), cada proceso tendría su propia
     cola en memoria. Los datos se dividirían entre procesos y cada uno haría sus propios
     insertMany(). Esto funciona correctamente en términos de consistencia.

   ═══════════════════════════════════════════════════════════ */
