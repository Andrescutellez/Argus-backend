/**
 * @fileoverview Script de seed: crea el usuario SUPER_ADMIN inicial.
 *
 * PROPÓSITO:
 *   Ejecutar UNA SOLA VEZ en la VM de GCP para crear la cuenta de acceso
 *   al Web Operador. No modifica usuarios existentes.
 *
 * USO:
 *   node scripts/seed-admin.js <email> <password>
 *   node scripts/seed-admin.js operador@argus.com MiClave123
 *
 * SEGURIDAD:
 *   Hashea la contraseña con bcrypt (mismo cost=12 que el authController).
 *   No guarda la contraseña en texto plano en ningún log ni tabla.
 *
 * @module scripts/seed-admin
 */

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const BCRYPT_ROUNDS = 12;

async function main() {
  const [,, email, password] = process.argv;

  if (!email || !password) {
    console.error('Uso: node scripts/seed-admin.js <email> <password>');
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL no definida en .env');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    await pool.query('SELECT 1');
    console.log('[SEED] Conectado a PostgreSQL');

    // Verificar si el email ya existe
    const { rows: existing } = await pool.query(
      'SELECT id, email, role FROM users WHERE email = $1',
      [email],
    );

    if (existing.length > 0) {
      const u = existing[0];
      if (u.role === 'SUPER_ADMIN' || u.role === 'ADMIN') {
        console.log(`[SEED] El usuario "${email}" ya existe con rol ${u.role}. No se modificó.`);
      } else {
        // Existe con USER — preguntar si elevar
        console.log(`[SEED] El usuario "${email}" existe con rol ${u.role}.`);
        console.log('[SEED] Para elevarlo a SUPER_ADMIN ejecuta en psql:');
        console.log(`       UPDATE users SET role = 'SUPER_ADMIN' WHERE email = '${email}';`);
      }
      return;
    }

    // Crear nuevo SUPER_ADMIN
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, 'SUPER_ADMIN')
       RETURNING id, email, role, created_at`,
      [email, passwordHash],
    );

    const user = rows[0];
    console.log('[SEED] ✓ Usuario creado exitosamente:');
    console.log(`       ID:    ${user.id}`);
    console.log(`       Email: ${user.email}`);
    console.log(`       Rol:   ${user.role}`);
    console.log(`       Fecha: ${user.created_at}`);
    console.log('[SEED] Ya puedes iniciar sesión en el Web Operador.');

  } catch (err) {
    console.error('[SEED] Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
