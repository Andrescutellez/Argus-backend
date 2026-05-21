/**
 * @fileoverview Pool de conexión a PostgreSQL y bootstrap del schema.
 *
 * PROPÓSITO:
 *   Centraliza la conexión a PostgreSQL con pg.Pool (reutiliza conexiones TCP)
 *   y crea las tablas si no existen al arrancar el servidor.
 *
 * VARIABLES CRÍTICAS:
 *   DATABASE_URL: connection string de PostgreSQL. Formato:
 *     postgresql://usuario:contraseña@host:5432/nombre_bd
 *   Sin esta variable, initPostgres() llama process.exit(1).
 *
 * TABLAS CREADAS:
 *   users         — cuenta de usuario con rol y contraseña hasheada
 *   user_devices  — relación M:N entre usuarios y dispositivos ESP32
 *   motos         — motocicleta física asociada a un usuario
 *   devices       — hardware ESP32 instalado en una moto
 *   subscriptions — plan freemium/premium por usuario
 *   audit_log     — registro inmutable de acciones críticas
 *
 * @module config/postgres
 */

'use strict';

const { Pool } = require('pg');

let pool = null;

/**
 * @brief Inicializa el pool y crea el schema si no existe.
 *
 * FLUJO:
 *   1. Crear Pool con DATABASE_URL (pg parsea el connection string automáticamente).
 *   2. Probar la conexión con un SELECT 1.
 *   3. Ejecutar DDL CREATE TABLE IF NOT EXISTS para users y user_devices.
 *   4. Si falla en cualquier paso, loguear y hacer process.exit(1).
 *
 * @returns {Promise<void>}
 */
async function initPostgres() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL no definida. Agrégala al .env');
    process.exit(1);
  }

  pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    await pool.query('SELECT 1');
    console.log('[PG] Conectado a PostgreSQL');
  } catch (err) {
    console.error('[PG] Error de conexión:', err.message);
    process.exit(1);
  }

  // Crear extension pgcrypto para gen_random_uuid() — disponible en PostgreSQL 13+.
  // En Railway, Supabase y Render ya viene habilitada por defecto.
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email         VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role          VARCHAR(20)  NOT NULL DEFAULT 'USER'
                    CHECK (role IN ('USER', 'ADMIN', 'SUPER_ADMIN')),
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  // user_devices vincula un usuario con los deviceIds ESP32 que le pertenecen.
  // Un usuario puede tener múltiples dispositivos; un dispositivo pertenece a un usuario.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_devices (
      user_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id VARCHAR(50) NOT NULL,
      PRIMARY KEY (user_id, device_id)
    )
  `);

  /**
   * motos — motocicleta física asociada a un usuario.
   * Un usuario puede tener varias motos; una moto pertenece a un usuario.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS motos (
      id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      alias      VARCHAR(50),
      placa      VARCHAR(20),
      marca      VARCHAR(50),
      modelo     VARCHAR(50),
      color      VARCHAR(30),
      anio       SMALLINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /**
   * devices — hardware ESP32 instalado en una moto.
   * device_id es el identificador que el ESP32 envía por TCP.
   * moto_id es nullable para permitir dispositivos no asignados aún.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id        VARCHAR(50) PRIMARY KEY,
      moto_id          UUID        REFERENCES motos(id) ON DELETE SET NULL,
      imei             VARCHAR(20),
      firmware_version VARCHAR(20),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /**
   * subscriptions — plan activo por usuario.
   * Un usuario tiene una suscripción activa a la vez.
   * Las expiradas quedan como historial (status = 'EXPIRED').
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan       VARCHAR(10) NOT NULL DEFAULT 'FREEMIUM'
                 CHECK (plan IN ('FREEMIUM', 'PREMIUM')),
      status     VARCHAR(10) NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE', 'EXPIRED', 'CANCELLED')),
      starts_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /**
   * audit_log — registro append-only de acciones críticas.
   * Nunca se actualiza ni borra. metadata guarda contexto extra en JSON.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
      action      VARCHAR(50) NOT NULL,
      target_type VARCHAR(30),
      target_id   VARCHAR(50),
      metadata    JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /**
   * manufactured_devices — catálogo de MACs autorizadas (pre-registradas de fábrica).
   * Solo los deviceIds presentes aquí pueden conectarse al servidor TCP y ser
   * asignados por usuarios. Esto previene que dispositivos clonados o desconocidos
   * entren al sistema. Gestionado exclusivamente por SUPER_ADMIN vía REST.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS manufactured_devices (
      device_id     VARCHAR(50) PRIMARY KEY,
      imei          VARCHAR(20),
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notes         TEXT
    )
  `);

  console.log('[PG] Schema listo (users, user_devices, motos, devices, subscriptions, audit_log, manufactured_devices)');
}

/**
 * @brief Retorna el pool activo para ejecutar queries.
 *
 * PROPÓSITO: Exponemos el pool como singleton para que los módulos de modelo
 * (User.js) puedan hacer pool.query() sin reimportar pg.Pool.
 *
 * @returns {import('pg').Pool}
 */
const getPool = () => pool;

module.exports = { initPostgres, getPool };
