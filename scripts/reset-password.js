'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

async function main() {
  const [,, email, newPassword] = process.argv;

  if (!email || !newPassword) {
    console.error('Uso: node scripts/reset-password.js <email> <nueva-contraseña>');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const { rows } = await pool.query('SELECT id, email, role FROM users WHERE email = $1', [email]);

    if (!rows.length) {
      console.error(`[RESET] No existe usuario con email: ${email}`);
      process.exit(1);
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [hash, email]);

    console.log(`[RESET] ✓ Contraseña actualizada para ${email} (rol: ${rows[0].role})`);
  } finally {
    await pool.end();
  }
}

main();
