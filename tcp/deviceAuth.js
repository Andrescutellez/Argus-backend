/**
 * @fileoverview Módulo de autenticación de dispositivos ESP32 para el servidor TCP de Argus.
 *
 * Implementa dos mecanismos de seguridad complementarios:
 *   1. Whitelist de deviceIds: solo los dispositivos registrados en ALLOWED_DEVICES
 *      pueden enviar datos al servidor.
 *   2. Verificación de firma CRC32: cada paquete incluye un checksum calculado
 *      sobre el payload + un secreto compartido (TCP_SECRET). Esto previene la
 *      forja de paquetes aunque el atacante conozca el formato del protocolo.
 *
 * NOTA DE SEGURIDAD:
 *   CRC32 NO es un algoritmo criptográfico. Es eficiente para detectar
 *   errores de transmisión y para dificultar ataques simples, pero un atacante
 *   con acceso al secreto puede calcular la firma correcta. Para seguridad real,
 *   se debería usar HMAC-SHA256. La ventaja de CRC32 aquí es que el ESP32 puede
 *   calcularlo en hardware (la mayoría tienen instrucción CRC32 en el Xtensa LX6/LX7)
 *   con muy bajo consumo de CPU y memoria.
 *
 * @module tcp/deviceAuth
 */

'use strict';

const ManufacturedDevice = require('../models/ManufacturedDevice');

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────

/**
 * Secreto compartido entre el servidor y cada ESP32.
 *
 * Se usa como "sal" (salt) en el cálculo del CRC32 para que la firma
 * dependa de un valor que el atacante no conoce. Si este secreto se filtra
 * (en logs, en el firmware del ESP32 sin protección, en el código fuente),
 * la seguridad de la autenticación queda comprometida.
 *
 * Sin fallback intencional: si TCP_SECRET no está definido en .env, el proceso
 * termina inmediatamente con código de error. Mismo patrón que MONGO_URI en server.js.
 * Esto garantiza que un despliegue sin secreto configurado falle de forma visible
 * en lugar de correr silenciosamente con el secreto público del código fuente.
 */
const SECRET = process.env.TCP_SECRET;
if (!SECRET) {
  console.error('ERROR: TCP_SECRET is not defined. Set it in .env before starting the server.');
  process.exit(1);
}

// ─── CACHE DE AUTORIZACIÓN ────────────────────────────────────────────────────

/**
 * Cache en memoria de resultados isManufactured() con TTL de 5 minutos.
 *
 * PROPÓSITO: el servidor TCP llama isAllowed() por cada paquete GPS recibido
 * (cada 3-30 segundos por device). Sin cache, cada paquete genera una query
 * SELECT a PostgreSQL. Con 50 devices activos serían >100 queries/min para
 * una respuesta que prácticamente nunca cambia.
 *
 * TTL de 5 min: balance entre frescura (un device revocado tarda max 5 min
 * en quedar bloqueado) y eficiencia (reducción de queries ~99%).
 *
 * @type {Map<string, { allowed: boolean, expiresAt: number }>}
 */
const allowedCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// ─── IMPLEMENTACIÓN DE CRC32 ──────────────────────────────────────────────────

/**
 * @brief Calcula el CRC32 de un string de texto usando el polinomio IEEE 802.3.
 *
 * PROPÓSITO:
 *   Generar un checksum de 32 bits del payload del paquete GPS (incluyendo el
 *   secreto compartido) para usarlo como firma. El ESP32 calcula el mismo CRC32
 *   sobre el mismo payload y lo adjunta al paquete; el servidor lo recalcula y
 *   compara.
 *
 * FLUJO LÓGICO:
 *   1. Inicializar el registro CRC con todos los bits en 1 (0xFFFFFFFF).
 *      Este valor inicial es convencional en CRC32; permite detectar streams
 *      de ceros al inicio del mensaje.
 *   2. Para cada byte del string:
 *      a. XOR el byte con el byte menos significativo del registro CRC.
 *      b. Para cada uno de los 8 bits del byte:
 *         - Si el bit menos significativo del CRC es 1, desplazar a la derecha
 *           y XOR con el polinomio 0xEDB88320 (reflejo del polinomio CRC32).
 *         - Si es 0, solo desplazar a la derecha.
 *   3. XOR final con 0xFFFFFFFF (complemento) y convertir a unsigned de 32 bits.
 *
 * NOTA TÉCNICA:
 *   El polinomio 0xEDB88320 es el reflejo bit a bit del polinomio CRC32 estándar
 *   (0x04C11DB7). Se usa la forma reflejada para procesar los bits de LSB a MSB,
 *   que es más eficiente en software y coincide con la implementación en hardware
 *   del ESP32 (instrucción CRC32B del Xtensa).
 *
 *   La operación `-(crc & 1)` es un truco de bitmask:
 *   - Si crc & 1 === 1 → -(1) en complemento a dos de 32 bits = 0xFFFFFFFF (todos 1s)
 *   - Si crc & 1 === 0 → -(0) = 0x00000000 (todos 0s)
 *   Hacer AND con el polinomio aplica o no aplica el XOR según el bit.
 *   Es más eficiente que un if/else porque evita branch mispredictions.
 *
 * DEPENDENCIAS:
 *   - Ninguna. Función pura sin efectos secundarios.
 *
 * POSIBLES MEJORAS (senior):
 *   - Reemplazar con HMAC-SHA256 usando el módulo nativo 'crypto' de Node.js:
 *     crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
 *     Esto daría autenticación criptográficamente segura con mínimo overhead.
 *   - Usar una tabla de lookup precomputada (256 entradas) para eliminar el
 *     loop interno de 8 iteraciones por byte, reduciendo de O(8n) a O(n).
 *
 * @param {string} text — El string sobre el que calcular el CRC32.
 * @returns {number} — El CRC32 como entero unsigned de 32 bits (0 a 4294967295).
 */
function crc32Argus(text) {
  // Valor inicial convencional de CRC32: todos los bits en 1.
  // Permite detectar mensajes que comienzan con bits en 0.
  let crc = 0xffffffff;

  for (let i = 0; i < text.length; i += 1) {
    // XOR del byte actual con el byte menos significativo del registro CRC.
    // charCodeAt devuelve el valor Unicode del carácter; para ASCII (0-127)
    // es equivalente al valor del byte. Para caracteres no-ASCII (>127)
    // charCodeAt devuelve el punto Unicode, que puede ser >255. Esto es una
    // limitación: el ESP32 trabaja con bytes puros. En la práctica el payload
    // solo contiene dígitos, letras y '|' (todos ASCII), así que no hay problema.
    crc ^= text.charCodeAt(i);

    // Procesar los 8 bits del byte mediante el algoritmo CRC32 reflejado.
    for (let bit = 0; bit < 8; bit += 1) {
      // Truco de bitmask: genera 0xFFFFFFFF si el LSB es 1, o 0x00000000 si es 0.
      const mask = -(crc & 1);

      // Desplazar a la derecha (unsigned, por eso >>>).
      // XOR con el polinomio solo si mask === 0xFFFFFFFF.
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }

  // XOR final para invertir los bits (complemento).
  // >>> 0 convierte a unsigned 32-bit, asegurando que el resultado sea positivo.
  // Sin >>> 0, en JavaScript el número podría ser negativo porque JS usa
  // signed 32-bit en operaciones bitwise.
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── FUNCIONES EXPORTADAS ─────────────────────────────────────────────────────

/**
 * @brief Verifica si un deviceId está en el catálogo de devices manufacturados.
 *
 * PROPÓSITO:
 *   Primera línea de defensa antes de gastar CPU en el cálculo de CRC32.
 *   Solo los devices pre-registrados en la tabla manufactured_devices (por un
 *   SUPER_ADMIN) pueden enviar datos al servidor TCP.
 *
 * FLUJO LÓGICO:
 *   1. Consultar manufactured_devices en PostgreSQL con SELECT LIMIT 1.
 *   2. Retornar true si existe una fila, false en caso contrario.
 *   3. Si la BD no está disponible, el error se propaga y el frame se rechaza
 *      (fallo seguro: ante duda, rechazar).
 *
 * DEPENDENCIAS:
 *   - ManufacturedDevice: modelo que encapsula la query a PostgreSQL.
 *
 * @param {string} deviceId — El identificador del dispositivo a verificar.
 * @returns {Promise<boolean>} — true si el device está autorizado.
 */
async function isAllowed(deviceId) {
  const cached = allowedCache.get(deviceId);
  if (cached && Date.now() < cached.expiresAt) return cached.allowed;

  const allowed = await ManufacturedDevice.isManufactured(deviceId);
  allowedCache.set(deviceId, { allowed, expiresAt: Date.now() + CACHE_TTL_MS });
  return allowed;
}

/**
 * @brief Verifica que la firma CRC32 del paquete GPS sea correcta.
 *
 * PROPÓSITO:
 *   Garantizar que el paquete fue generado por un ESP32 legítimo que posee
 *   el secreto TCP_SECRET. Sin esta verificación, cualquiera que conozca el
 *   formato del protocolo Argus podría enviar coordenadas falsas para un
 *   dispositivo registrado.
 *
 * FLUJO LÓGICO:
 *   1. Verificar que lat y lng son números finitos (no NaN, no Infinity).
 *      Si no lo son, la reconstrucción del payload fallará silenciosamente.
 *   2. Reconstruir el string de payload EXACTAMENTE como lo construye el ESP32:
 *      "{deviceId}|{timestamp}|{lat:.6f}|{lng:.6f}|{SECRET}"
 *   3. Calcular CRC32 del payload reconstruido.
 *   4. Convertir a hexadecimal uppercase, paddeado a 8 caracteres.
 *   5. Comparar con la firma recibida (normalizada a uppercase y sin whitespace).
 *
 * NOTA CRÍTICA SOBRE toFixed(6):
 *   El ESP32 formatea lat y lng con 6 decimales en su payload antes de calcular
 *   el CRC32. El servidor debe usar exactamente el mismo formato. Si el ESP32
 *   enviara "19.432" pero el servidor reconstruyera "19.432000", el CRC32 sería
 *   diferente y la verificación fallaría. Por eso usamos lat.toFixed(6) y
 *   lng.toFixed(6), que siempre produce exactamente 6 decimales.
 *
 * DEPENDENCIAS:
 *   - SECRET: constante del módulo.
 *   - crc32Argus(): función de este módulo.
 *
 * POSIBLES MEJORAS (senior):
 *   - Incluir el timestamp en la verificación de replay attacks: si el timestamp
 *     del paquete es más de 30 segundos más antiguo que Date.now(), rechazar el
 *     paquete aunque la firma sea válida. Actualmente un atacante podría capturar
 *     un paquete válido y reenviarlo indefinidamente.
 *   - Reemplazar CRC32 con HMAC-SHA256 para seguridad criptográfica real.
 *   - Implementar nonces: cada ACK incluye un número aleatorio que el ESP32 debe
 *     incluir en el próximo paquete, haciendo que cada firma sea única.
 *
 * @param {string} deviceId — Identificador del dispositivo.
 * @param {string} timestamp — Timestamp en milisegundos (como string, tal como viene del frame).
 * @param {number} lat — Latitud ya convertida a Number por parsePacket().
 * @param {number} lng — Longitud ya convertida a Number por parsePacket().
 * @param {string} signature — La firma hexadecimal recibida en el paquete (campo 6).
 * @returns {boolean} — true si la firma es válida; false si fue alterada o es incorrecta.
 */
function verifySignature(deviceId, timestamp, lat, lng, signature) {
  // Validación previa: si lat o lng no son números finitos, el toFixed() de abajo
  // fallaría o produciría resultados inesperados ("NaN" o "Infinity").
  // Este check evita excepciones y retorna false de forma limpia.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return false;
  }

  // Reconstrucción del payload EXACTAMENTE como lo construye el firmware del ESP32.
  // El orden, los separadores '|' y el número de decimales deben coincidir byte a byte.
  // toFixed(6) garantiza exactamente 6 decimales: 19.432 → "19.432000"
  // Cualquier discrepancia en el formato (ej: 5 vs 6 decimales) resulta en CRC32 diferente.
  const payload = `${deviceId}|${timestamp}|${lat.toFixed(6)}|${lng.toFixed(6)}|${SECRET}`;

  // Calcular el CRC32 y formatear como hex uppercase de 8 dígitos.
  // padStart(8, '0') asegura el relleno: si el CRC es 0x00001234, produce "00001234" no "1234".
  // El ESP32 también hace padding a 8 dígitos en su firmware.
  const expected = crc32Argus(payload).toString(16).toUpperCase().padStart(8, '0');

  // Comparación case-insensitive (toUpperCase en ambos) y sin whitespace (trim en signature).
  // Esto es tolerante a variaciones de formato del firmware (minúsculas, espacios extra).
  return expected === String(signature || '').trim().toUpperCase();
}

// ─── EXPORTACIONES ────────────────────────────────────────────────────────────
// isAllowed es ahora async (consulta PostgreSQL). El caller debe usar await.
module.exports = { isAllowed, verifySignature };


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — tcp/deviceAuth.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este módulo es el "portero" del sistema. Cuando un paquete GPS llega por TCP,
   este módulo hace dos preguntas: ¿Este dispositivo está en mi lista de invitados?
   (whitelist) y ¿La firma del mensaje es correcta? (CRC32). Solo si ambas
   respuestas son "sí", el paquete se acepta. Es como un sobre con un sello de
   cera: cualquiera puede ver el sobre, pero solo quien tiene el sello correcto
   puede generar un sello idéntico. Si el sello está roto o es incorrecto, el
   sobre se descarta.

   PSEUDOCÓDIGO:
   isAllowed(deviceId):  [ASYNC]
     → SELECT 1 FROM manufactured_devices WHERE device_id = ?
     → retornar rows.length > 0

   verifySignature(deviceId, timestamp, lat, lng, signature):
     → si lat o lng no son números finitos → return false
     → construir payload = "deviceId|timestamp|lat.6f|lng.6f|SECRET"
     → calcular crc32 del payload
     → formatear como hex uppercase de 8 dígitos
     → comparar con la firma recibida (normalizada)
     → retornar true si son iguales

   crc32Argus(text):
     → implementación software del CRC32 con polinomio IEEE 802.3
     → misma implementación que usa el ESP32 en hardware

   DIAGRAMA MENTAL:
   Paquete llegado → isAllowed(deviceId)?
                           ↓ no → rechazar (ERR)
                           ↓ sí
                     verifySignature(datos)?
                           ↓ no → rechazar (ERR)
                           ↓ sí
                     [procesar paquete]

   VARIABLES CRÍTICAS:
   - SECRET: si se filtra, cualquiera puede forjar paquetes válidos para cualquier device registrado
   - manufactured_devices (PostgreSQL): si la tabla está vacía, ningún device puede enviar datos

   RIESGOS DE SEGURIDAD:
   - CRC32 no es criptográficamente seguro: susceptible a ataques de colisión premeditados
   - No hay protección contra replay attacks: un paquete capturado es válido indefinidamente
   - El secreto TCP_SECRET tiene fallback a valor público conocido en el código fuente
   - La whitelist es estática: no se puede revocar un device sin reiniciar el servidor

   RIESGOS DE CONCURRENCIA:
   - ALLOWED_DEVICES es un Set inmutable después del arranque: sin riesgos de concurrencia.
   - crc32Argus() es una función pura sin estado compartido: thread-safe por definición.
   - SECRET y ALLOWED_DEVICES son constantes de módulo: se inicializan una vez y son de solo lectura.

   ═══════════════════════════════════════════════════════════ */
