#!/usr/bin/env node
/**
 * @brief Genera un certificado TLS self-signed para el servidor TCP de Argus.
 *
 * PROPÓSITO:
 *   El servidor TCP de Argus soporta un canal TLS en el puerto 9001 (paralelo
 *   al TCP plano en 9000). Este script genera la clave privada y el certificado
 *   self-signed necesarios para activarlo.
 *
 *   El firmware A7670 usa AT+CSSLCFG="ignorecertificate" — no verifica la
 *   identidad del servidor, solo cifra el canal. Un certificado self-signed
 *   es suficiente para este modelo de amenazas.
 *
 * USO:
 *   node scripts/gen-tls-cert.js
 *
 * SALIDA:
 *   certs/key.pem   — clave privada RSA 2048 bits
 *   certs/cert.pem  — certificado X.509 self-signed, válido 10 años
 *
 * REQUISITO:
 *   openssl en el PATH. Disponible en Linux/macOS/Git Bash en Windows.
 *   En Windows PowerShell puro: instalar OpenSSL o usar Git Bash.
 *
 * SEGURIDAD:
 *   NUNCA subir certs/key.pem ni certs/cert.pem a Git.
 *   El .gitignore ya los excluye.
 *   Copiar ambos archivos al servidor GCP en el mismo path (certs/).
 */

'use strict';

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const certsDir = path.join(__dirname, '..', 'certs');
const keyPath  = path.join(certsDir, 'key.pem');
const certPath = path.join(certsDir, 'cert.pem');

if (!fs.existsSync(certsDir)) {
  fs.mkdirSync(certsDir, { recursive: true });
}

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  console.log('✅  Los certificados ya existen en certs/');
  console.log('    Bórralos manualmente si quieres regenerarlos:');
  console.log('    del certs\\key.pem certs\\cert.pem   (Windows)');
  console.log('    rm certs/key.pem certs/cert.pem    (Linux/Mac)');
  process.exit(0);
}

console.log('Generando certificado TLS self-signed para Argus TCP...\n');

try {
  execSync(
    `openssl req -x509 -newkey rsa:2048 `
    + `-keyout "${keyPath}" -out "${certPath}" `
    + `-days 3650 -nodes `
    + `-subj "/CN=argus-tcp/O=Argus Secure/C=CO"`,
    { stdio: 'inherit' },
  );
} catch (err) {
  console.error('\n❌  Error ejecutando openssl.');
  console.error('    Verifica que openssl esté instalado y en el PATH.');
  console.error('    En Windows: usa Git Bash o instala OpenSSL for Windows.');
  process.exit(1);
}

console.log(`
✅  Generado:
    Clave:        ${keyPath}
    Certificado:  ${certPath}

Próximos pasos:
  1. Copiar certs/key.pem y certs/cert.pem al servidor GCP:
       scp certs/key.pem certs/cert.pem usuario@34.69.219.193:~/Argus\\ Backend/certs/

  2. En GCP: abrir el puerto 9001 en el firewall VPC
       (igual que abriste el 9000, pero con TCP_TLS_PORT=9001)

  3. Configurar TCP_TLS_PORT=9001, TLS_KEY_PATH y TLS_CERT_PATH en .env del servidor

  4. Flashear firmware con TCP_USE_TLS=1 en a7670_driver.h

⚠️  NUNCA subir key.pem ni cert.pem a Git — ya están en .gitignore
`);
