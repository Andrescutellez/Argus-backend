-- =============================================================
-- 00_enable_postgis.sql
-- Ejecutar como superusuario de PostgreSQL (postgres), NO como argus_user.
--
-- PROPÓSITO:
--   Habilitar las extensiones PostGIS en la base de datos argus.
--   Solo se ejecuta una vez. Requiere privilegio de superusuario.
--
-- CÓMO EJECUTAR EN LA VM:
--   sudo -u postgres psql -d argus -f 00_enable_postgis.sql
--
-- VERIFICAR:
--   SELECT PostGIS_Version();  → debe devolver "3.x.x ..."
-- =============================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- pgcrypto ya debería existir (lo crea el backend principal)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Verificar instalación
DO $$
BEGIN
  RAISE NOTICE 'PostGIS version: %', PostGIS_Version();
END $$;
