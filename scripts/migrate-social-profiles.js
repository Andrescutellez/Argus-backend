'use strict';
/**
 * Migración: tabla social_profiles y username_history.
 * Ejecutar UNA SOLA VEZ: node scripts/migrate-social-profiles.js
 *
 * También crea perfiles para todos los usuarios existentes que no tengan uno,
 * usando el prefijo del email como username base (con sufijo numérico si hay conflicto).
 */
require('dotenv').config();
const { initPostgres, getPool } = require('../config/postgres');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS social_profiles (
  user_id       UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username      VARCHAR(30)  UNIQUE NOT NULL,
  display_name  VARCHAR(80),
  bio           TEXT,
  city          VARCHAR(100),
  avatar_url    VARCHAR(500),
  is_public     BOOLEAN      NOT NULL DEFAULT TRUE,
  argus_verified BOOLEAN     NOT NULL DEFAULT FALSE,
  social_status  VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                 CHECK (social_status IN ('ACTIVE','SUSPENDED','BANNED')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS username_history (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username    VARCHAR(30) NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_profiles_username ON social_profiles(username);
CREATE INDEX IF NOT EXISTS idx_username_history_user    ON username_history(user_id);
`;

function generateBase(email) {
  const prefix = email.split('@')[0];
  const clean = prefix
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')   // solo alfanum + guión bajo
    .replace(/_{2,}/g, '_')         // colapsar múltiples guiones bajos
    .replace(/^_+|_+$/g, '')        // sin guiones al inicio/fin
    .slice(0, 28);
  return clean || 'user';
}

(async () => {
  await initPostgres();
  const pool = getPool();

  // 1. Crear tablas e índices
  await pool.query(SCHEMA);
  console.log('✅ Tablas social_profiles y username_history listas.');

  // 2. Crear perfiles para usuarios que aún no tienen uno
  const { rows: users } = await pool.query(`
    SELECT u.id, u.email
    FROM users u
    LEFT JOIN social_profiles sp ON sp.user_id = u.id
    WHERE sp.user_id IS NULL
  `);

  if (users.length === 0) {
    console.log('✅ Todos los usuarios ya tienen perfil social.');
    process.exit(0);
  }

  console.log(`⏳ Creando perfiles para ${users.length} usuario(s) existente(s)...`);

  // Cargar usernames ya existentes para detectar conflictos en memoria
  const { rows: taken } = await pool.query('SELECT username FROM social_profiles');
  const takenSet = new Set(taken.map(r => r.username));

  for (const user of users) {
    const base = generateBase(user.email);
    let candidate = base;
    let suffix = 2;

    // Asegurar unicidad sin requerir DB round-trips por cada intento
    while (takenSet.has(candidate)) {
      candidate = base.slice(0, 25) + '_' + suffix;
      suffix++;
    }
    takenSet.add(candidate);

    await pool.query(
      `INSERT INTO social_profiles (user_id, username) VALUES ($1, $2)`,
      [user.id, candidate],
    );
    console.log(`  • ${user.email} → @${candidate}`);
  }

  console.log('✅ Migración de perfiles sociales completada.');
  process.exit(0);
})().catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});
