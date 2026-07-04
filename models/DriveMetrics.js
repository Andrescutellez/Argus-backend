/**
 * @fileoverview Schema Mongoose para métricas de conducción capturadas por el MPU6050.
 *
 * PROPÓSITO:
 *   Persistir las métricas de conducción que el ESP32 acumula durante cada ventana
 *   GPS (~30s en PREMIUM). Cada documento representa una "muestra de conducción":
 *   el pico de aceleración y giro registrados, más la cantidad de maniobras bruscas
 *   y suaves detectadas por el MPU6050 en ese intervalo.
 *
 * DIFERENCIA CON gps (models/Gps.js):
 *   - Gps almacena posición puntual con frecuencia constante.
 *   - DriveMetrics almacena el comportamiento de conducción del intervalo entre
 *     dos posiciones GPS. Son complementarios: el GPS dice DÓNDE, DriveMetrics
 *     dice CÓMO (agresividad de la conducción).
 *
 * FLUJO DE DATOS:
 *   ESP32 (sensor_task.cpp acumula g_driveMetrics)
 *     → comm_task.cpp envía frame "DRIVE|id|epoch|lat|lon|accel|gyro|hard|soft|crc32\n"
 *     → tcpServer.js parsea y llama persistDriveMetrics()
 *     → DriveMetrics.create(data)
 *     → GET /api/drive/metrics/:deviceId agrega y sirve al frontend
 *
 * ÍNDICES:
 *   - { deviceId, timestamp: -1 }: la query más común es "últimas N muestras
 *     de este device". El índice compuesto cubre ambas condiciones.
 *
 * VARIABLES CRÍTICAS:
 *   - peakAccelDev: desviación de 1g en unidades g. En reposo = 0.
 *     Una frenada fuerte genera ~0.5g. Un impacto severo supera 1.5g.
 *   - peakGyroMag: magnitud del vector giroscopio en °/s. Un giro brusco
 *     de manillar puede superar 50°/s. Sirve como proxy de conducción agresiva
 *     en curvas o maniobras evasivas.
 *   - hardCount: cuenta de EVENT_MOVEMENT_HARD + EVENT_IMPACT_DETECTED. Si es
 *     consistentemente alto, indica conductor agresivo o moto con problemas mecánicos.
 *   - softCount: cuenta de EVENT_MOVEMENT_SOFT. Referencia para normalizar hardCount.
 *
 * @module models/DriveMetrics
 */

'use strict';

const { Schema, model } = require('mongoose');

const DriveMetricsSchema = new Schema(
  {
    deviceId: {
      type: String,
      required: true,
      index: true,
    },

    /**
     * Coordenadas GPS al momento de la muestra.
     * null si el ESP32 no tenía fix GPS en ese intervalo.
     * Permite mostrar en el mapa dónde ocurrieron las maniobras más agresivas.
     */
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },

    /**
     * Pico de desviación de la magnitud de aceleración respecto a 1g, en unidades g.
     *
     * CÓMO SE CALCULA EN EL FIRMWARE:
     *   accelMag = sqrt(ax² + ay² + az²)   [g]
     *   peakAccelDev = max(|accelMag - 1.0|) durante la ventana
     *
     * En reposo (solo gravedad): accelMag ≈ 1g → peakAccelDev ≈ 0.
     * Frenada fuerte: peakAccelDev ≈ 0.5g.
     * Impacto / caída: peakAccelDev > 1.5g.
     *
     * Unidades: g (fuerza g, donde 1g = 9.8 m/s²)
     */
    peakAccelDev: { type: Number, required: true, min: 0 },

    /**
     * Pico de la magnitud del vector giroscopio durante la ventana, en °/s.
     *
     * CÓMO SE CALCULA EN EL FIRMWARE:
     *   peakGyroMag = max(sqrt(gx² + gy² + gz²)) durante la ventana
     *
     * En reposo: ≈ 0°/s.
     * Giro urbano normal: 5–15°/s.
     * Cambio brusco de carril: 20–40°/s.
     * Maniobra evasiva: > 50°/s.
     *
     * Unidades: grados por segundo (°/s)
     */
    peakGyroMag: { type: Number, required: true, min: 0 },

    /**
     * Cantidad de eventos EVENT_MOVEMENT_HARD o EVENT_IMPACT_DETECTED en la ventana.
     * Proxy de maniobras bruscas: frenadas de emergencia, aceleraciones abruptas, impactos.
     */
    hardCount: { type: Number, required: true, min: 0, default: 0 },

    /**
     * Cantidad de eventos EVENT_MOVEMENT_SOFT en la ventana.
     * Proxy de maniobras suaves: movimiento normal de conducción o tráfico lento.
     */
    softCount: { type: Number, required: true, min: 0, default: 0 },

    /**
     * Velocidad media haversine de la ventana (~30s) en km/h.
     * Calculada en firmware como distancia(prev_fix, curr_fix) / tiempo_entre_fixes.
     * Mucho más precisa que la velocidad GNSS instantánea, especialmente tras GPS sleep.
     * null si el firmware es anterior a v2 del frame DRIVE (dispositivos no actualizados).
     */
    avgSpeedKmh: { type: Number, default: null },

    /**
     * Distancia recorrida haversine en la ventana en metros.
     * Permite al backend calcular km totales recorridos en el período sin depender de GPS.
     * null si el firmware es anterior a v2 del frame DRIVE.
     */
    distanceM: { type: Number, default: null },

    /**
     * Timestamp de fin de la ventana de medición (epoch_ms del ESP32, convertido a Date).
     * Para source='device': timestamp del frame DRIVE que cierra la ventana.
     */
    timestamp: { type: Date, required: true },
  },
  {
    // createdAt diferencia cuándo llegó el dato al servidor de cuándo ocurrió en el hardware.
    timestamps: true,
  },
);

// Índice compuesto para la query más frecuente: muestras recientes de un device.
// Sin este índice, .find({ deviceId }).sort({ timestamp: -1 }) haría full scan.
DriveMetricsSchema.index({ deviceId: 1, timestamp: -1 });

module.exports = model('DriveMetrics', DriveMetricsSchema);


/* ═══════════════════════════════════════════════════════════
   RESUMEN DEL MÓDULO — models/DriveMetrics.js
   ═══════════════════════════════════════════════════════════

   EXPLICACIÓN PARA HUMANO:
   Este modelo guarda una "foto" del comportamiento de la moto cada vez que el
   ESP32 envía su posición GPS (cada ~30 segundos). Cada foto incluye: cuán
   bruscas fueron las aceleraciones y giros, y cuántas maniobras intensas o
   suaves ocurrieron. Con estas fotos se puede calcular un "score de conducción"
   y mostrar gráficos de cómo varía el estilo de manejo durante la semana.

   PSEUDOCÓDIGO:
   Colección "drivemetrics":
     _id, deviceId, lat, lon,
     peakAccelDev (g), peakGyroMag (°/s),
     hardCount, softCount,
     timestamp, createdAt, updatedAt

   Query típica:
     DriveMetrics.find({ deviceId, timestamp: { $gte: hace7dias } })
       .sort({ timestamp: -1 })

   DIAGRAMA MENTAL:
   ESP32 sensor_task → g_driveMetrics acumula durante 30s
   ESP32 comm_task   → DRIVE frame (lat, lon, peakAccel, peakGyro, hard, soft)
   tcpServer.js      → parseDrivePacket() + persistDriveMetrics()
   DriveMetrics doc  → guardado en MongoDB
   GET /api/drive/metrics/:deviceId → agrega por período → app/web

   VARIABLES CRÍTICAS:
   - peakAccelDev y peakGyroMag: deben interpretarse como picos del intervalo, no promedios.
     Un valor alto en un único intervalo puede bajar el score del día entero.
   - hardCount: si el firmware envía un valor muy alto, revisar si la sensitivity
     del MPU está calibrada correctamente para el modelo de moto.
   - índice compuesto { deviceId, timestamp }: crítico para queries de historial semanal.

   ═══════════════════════════════════════════════════════════ */
