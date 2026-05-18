/**
 * @fileoverview Módulo de conexión a MongoDB Atlas via Mongoose.
 *
 * PROPÓSITO:
 *   Abstraer la lógica de conexión a la base de datos en una función reutilizable.
 *   Se llama una sola vez desde server.js al arrancar el proceso. Mongoose gestiona
 *   internamente el pool de conexiones y el reconect automático después de llamar connectDB().
 *
 * DISEÑO DE CONEXIÓN:
 *   Mongoose mantiene una conexión persistente al pool de MongoDB Atlas. Las queries
 *   del modelo Gps.js no necesitan hacer connect/disconnect explícitos: simplemente
 *   llaman a Gps.find(), Gps.save(), etc., y Mongoose usa la conexión del pool.
 *   Si la conexión cae, Mongoose intenta reconectarse automáticamente (behavior por defecto).
 *
 * VARIABLES CRÍTICAS:
 *   - process.env.MONGO_URI: URI de conexión a MongoDB Atlas, incluyendo usuario, contraseña
 *     y base de datos. Si no está definida, el servidor ya habrá abortado en server.js
 *     antes de llamar connectDB(). Si está mal formada, mongoose.connect() lanza un error.
 *
 * @module config/db
 */

'use strict';

const mongoose = require('mongoose');

/**
 * @brief Establece la conexión a MongoDB Atlas usando Mongoose.
 *
 * PROPÓSITO:
 *   Inicializar el pool de conexiones de Mongoose. Después de que esta función
 *   resuelve con éxito, cualquier query en cualquier modelo Mongoose será enrutada
 *   automáticamente por el pool sin necesidad de reconectarse.
 *
 * FLUJO LÓGICO:
 *   1. Llamar mongoose.connect() con MONGO_URI del entorno.
 *   2. Si la conexión es exitosa, loguear el host del servidor MongoDB conectado.
 *   3. Si hay un error (credenciales inválidas, Atlas caído, URI malformada), loguear y
 *      llamar process.exit(1) para abortar el proceso. No tiene sentido operar sin BD.
 *
 * COMPORTAMIENTO DE RECONEXIÓN:
 *   Mongoose tiene reconexión automática habilitada por defecto. Si la conexión se pierde
 *   DESPUÉS de que connectDB() resolvió, Mongoose intentará reconectarse sin que el código
 *   de la aplicación lo gestione explícitamente. Esto es comportamiento del pool de Mongoose,
 *   no de esta función.
 *
 * DEPENDENCIAS:
 *   - mongoose: librería de ODM para MongoDB.
 *   - process.env.MONGO_URI: URI de Atlas, garantizada no-undefined por el guard en server.js.
 *
 * POSIBLES MEJORAS (senior):
 *   1. Pasar opciones de conexión para tuning: mongoose.connect(uri, {
 *        maxPoolSize: 10,          // máximo de conexiones concurrentes
 *        serverSelectionTimeoutMS: 5000,  // timeout de selección de servidor primario
 *        socketTimeoutMS: 45000,   // timeout de socket individual
 *      })
 *      Los defaults de Mongoose son razonables para un MVP pero pueden necesitar
 *      ajuste bajo carga alta.
 *   2. Registrar listeners de eventos de conexión para monitoreo:
 *      mongoose.connection.on('disconnected', () => log('error', 'db.disconnected', {}))
 *      mongoose.connection.on('reconnected', () => log('info', 'db.reconnected', {}))
 *      Esto permitiría al sistema de alertas detectar períodos de desconexión.
 *   3. Retornar la conexión (conn) para que server.js pueda verificar el estado
 *      o cerrar explícitamente en un graceful shutdown.
 *
 * @returns {Promise<void>} — Resuelve si la conexión fue exitosa. Si falla, llama
 *   process.exit(1) antes de rechazar, por lo que el caller no recibirá el rechazo.
 */
const connectDB = async () => {
  try {
    // mongoose.connect() resuelve con un objeto que contiene conn.connection.host:
    // el hostname del servidor MongoDB al que se conectó (útil para verificar que
    // el entorno apunta al Atlas correcto, no a un servidor de pruebas accidentalmente).
    const conn = await mongoose.connect(process.env.MONGO_URI);

    // El host confirmado en el log verifica que la URI apunta al cluster correcto.
    // Útil para detectar errores de configuración en distintos entornos (dev/staging/prod).
    console.log(`✅ MongoDB conectado: ${conn.connection.host}`);
  } catch (error) {
    // Causas comunes de error aquí:
    // - URI malformada (falta el protocolo 'mongodb+srv://')
    // - Credenciales inválidas (usuario/contraseña incorrectos)
    // - IP del servidor no en la whitelist de Atlas
    // - Atlas temporalmente caído o plan expirado
    console.error(`❌ Error al conectar a MongoDB: ${error.message}`);

    // process.exit(1) termina el proceso con código de error no-cero.
    // Esto hace que systemd, Docker, o GCP Cloud Run intenten reiniciar el proceso.
    // Sin este exit, el servidor arrancaría pero cada query generaría un error de
    // "MongoNotConnectedError" o un Promise pendiente que nunca resuelve.
    process.exit(1);
  }
};

// Exportar la función para que server.js pueda llamarla al arrancar.
// Solo se exporta la función; mongoose y la conexión son internos al módulo.
module.exports = connectDB;


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — config/db.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este módulo hace una sola cosa: conectar la aplicación a la base de datos
   MongoDB en la nube (Atlas). Es como marcar un número de teléfono: si la
   llamada entra, todo funciona. Si no entra (mal número, sin señal), el sistema
   se apaga inmediatamente en lugar de intentar funcionar sin base de datos,
   lo cual causaría errores confusos en todos los endpoints.

   PSEUDOCÓDIGO:
   connectDB():
     → await mongoose.connect(MONGO_URI)
     → si OK → loguear host + retornar
     → si error → loguear error + process.exit(1)

   DIAGRAMA MENTAL:
   server.js
     ↓ connectDB()
   mongoose.connect(MONGO_URI)
     ↓ éxito → pool de conexiones activo → queries de Gps.js funcionan
     ↓ error → process.exit(1) → proceso termina → Cloud Run reinicia

   VARIABLES CRÍTICAS:
   - MONGO_URI: si apunta al cluster incorrecto (ej: dev en vez de prod),
     los datos se escriben en la BD equivocada. No hay validación del nombre de BD.

   RIESGOS DE SEGURIDAD:
   - MONGO_URI contiene usuario y contraseña de MongoDB Atlas. Si se loguea
     (accidentalmente en un catch), las credenciales quedan expuestas en los logs.
   - El error solo se loguea como error.message, no como el objeto completo,
     lo que evita que la URI completa aparezca en los logs.

   RIESGOS DE CONCURRENCIA:
   - connectDB() es async y se llama sin await en server.js (intencionalmente).
     Mongoose encola internamente las queries hasta que la conexión esté lista,
     así que no hay riesgo de queries antes de conectar.
   - Llamar connectDB() múltiples veces crearía conexiones redundantes al pool.
     En server.js se llama exactamente una vez.

   ═══════════════════════════════════════════════════════════ */
