-- =============================================================
-- 01_gis_schema.sql
-- Schema GIS completo para Argus Secure — Bogotá.
-- Ejecutar DESPUÉS de 00_enable_postgis.sql.
--
-- ORDEN DE CREACIÓN (respeta FKs):
--   1. localidades → 2. upz → 3. sectores_catastrales
--   4. cuadrantes (FK → 1,2,3)
--   5. cai, estaciones_policia, jurisdicciones_cai (FK → 1)
--   6. entornos (FK → 1,2,3)   ← tabla maestra de lookup
--   7. delitos_hurto_motos (FK → 1)
--   8. incidentes_nuse (FK → 3)
--   9. rnmc (FK → 3)
--  10. heatmaps (sin FK)
--  11. gis_sync_log (sin FK)
--  12. mv_risk_sector (materialized view sobre 3 + 8)
--  13. argus_lookup() (función SQL sobre 6 + 4)
--
-- GEOMETRÍAS:
--   Todas en SRID 4326 (WGS84). OAIEE devuelve MAGNA-SIRGAS
--   convertido a WGS84 via datumTransformation=15738.
-- =============================================================


-- ============================================================
-- 1. localidades — 21 localidades de Bogotá (base de todo)
-- ============================================================
CREATE TABLE IF NOT EXISTS localidades (
  loc_codigo  CHAR(2)                    PRIMARY KEY,
  loc_nombre  VARCHAR(50)                NOT NULL,
  loc_area_m2 DOUBLE PRECISION,
  geom        GEOMETRY(MULTIPOLYGON, 4326)
);
CREATE INDEX IF NOT EXISTS idx_localidades_geom ON localidades USING GIST(geom);


-- ============================================================
-- 2. upz — 123 Unidades de Planeamiento Zonal
-- ============================================================
CREATE TABLE IF NOT EXISTS upz (
  upl_codigo  VARCHAR(10)                PRIMARY KEY,
  upl_nombre  VARCHAR(50)                NOT NULL,
  upl_tipo    VARCHAR(30),
  upl_area_m2 DOUBLE PRECISION,
  loc_codigo  CHAR(2)                    REFERENCES localidades(loc_codigo),
  geom        GEOMETRY(MULTIPOLYGON, 4326)
);
CREATE INDEX IF NOT EXISTS idx_upz_geom ON upz USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_upz_loc  ON upz(loc_codigo);


-- ============================================================
-- 3. sectores_catastrales — 1,196 sectores (clave de join P1/P2/P3)
-- ============================================================
CREATE TABLE IF NOT EXISTS sectores_catastrales (
  sca_codigo  CHAR(6)                    PRIMARY KEY,
  sca_nombre  VARCHAR(60)                NOT NULL,
  loc_codigo  CHAR(2)                    REFERENCES localidades(loc_codigo),
  upl_codigo  VARCHAR(10)                REFERENCES upz(upl_codigo),
  geom        GEOMETRY(MULTIPOLYGON, 4326)
);
CREATE INDEX IF NOT EXISTS idx_scat_geom ON sectores_catastrales USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_scat_loc  ON sectores_catastrales(loc_codigo);


-- ============================================================
-- 4. cuadrantes ⭐ DIFERENCIADOR ÚNICO DE ARGUS EN LATAM
--    pcu_telefono = teléfono celular del patrullero asignado
--    Feature: en robo confirmado → llamar/SMS al patrullero del cuadrante
-- ============================================================
CREATE TABLE IF NOT EXISTS cuadrantes (
  pcu_codigo   VARCHAR(10)               PRIMARY KEY,
  pcu_nom_cai  VARCHAR(50),
  pcu_nom_est  VARCHAR(20),
  pcu_telefono VARCHAR(12),
  loc_codigo   CHAR(2)                   REFERENCES localidades(loc_codigo),
  sca_codigo   CHAR(6)                   REFERENCES sectores_catastrales(sca_codigo),
  upl_codigo   VARCHAR(10)               REFERENCES upz(upl_codigo),
  geom         GEOMETRY(MULTIPOLYGON, 4326),
  updated_at   TIMESTAMPTZ               DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cuad_geom ON cuadrantes USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_cuad_loc  ON cuadrantes(loc_codigo);


-- ============================================================
-- 5. cai — 154 Comandos de Atención Inmediata (puntos)
-- ============================================================
CREATE TABLE IF NOT EXISTS cai (
  epo_objectid  INTEGER                  PRIMARY KEY,
  epo_nombre    VARCHAR(100),
  epo_direccion VARCHAR(150),
  epo_lat       DOUBLE PRECISION,
  epo_lon       DOUBLE PRECISION,
  loc_codigo    CHAR(2)                  REFERENCES localidades(loc_codigo),
  geom          GEOMETRY(POINT, 4326),
  updated_at    TIMESTAMPTZ              DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cai_geom ON cai USING GIST(geom);


-- ============================================================
-- 6. estaciones_policia — 21 estaciones (1 por localidad)
-- ============================================================
CREATE TABLE IF NOT EXISTS estaciones_policia (
  epo_objectid  INTEGER                  PRIMARY KEY,
  epo_nombre    VARCHAR(100),
  epo_direccion VARCHAR(150),
  epo_lat       DOUBLE PRECISION,
  epo_lon       DOUBLE PRECISION,
  epo_telefono  VARCHAR(20),
  epo_horario   VARCHAR(50)              DEFAULT '24 horas',
  loc_codigo    CHAR(2)                  REFERENCES localidades(loc_codigo),
  geom          GEOMETRY(POINT, 4326),
  updated_at    TIMESTAMPTZ              DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_estpol_geom ON estaciones_policia USING GIST(geom);


-- ============================================================
-- 7. jurisdicciones_cai — 153 polígonos jurisdiccionales
--    jcai_entorno = flag entorno priorizado → variable f₉ del ARU
-- ============================================================
CREATE TABLE IF NOT EXISTS jurisdicciones_cai (
  jcai_cod_juris  VARCHAR(6)             PRIMARY KEY,
  jcai_nom_cai    VARCHAR(50),
  jcai_nom_est    VARCHAR(20),
  loc_codigo      CHAR(2)                REFERENCES localidades(loc_codigo),
  jcai_entorno    TEXT,
  geom            GEOMETRY(MULTIPOLYGON, 4326),
  updated_at      TIMESTAMPTZ            DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jurcai_geom ON jurisdicciones_cai USING GIST(geom);


-- ============================================================
-- 8. entornos ⭐ TABLA MAESTRA DE LOOKUP ESPACIAL
--    59,384 micro-polígonos con buffer 100m.
--    Cada polígono tiene toda la jerarquía embebida:
--    localidad → UPZ → sector → cuadrante → CAI.
--    Un solo ST_Contains sobre esta tabla resuelve todo.
--    Sin FK a cuadrantes para tolerar discrepancias menores
--    entre S9 y S3 (carga independiente desde OAIEE).
-- ============================================================
CREATE TABLE IF NOT EXISTS entornos (
  objectid    INTEGER                    PRIMARY KEY,
  hiunico     INTEGER                    NOT NULL,
  loc_codigo  CHAR(2)                    REFERENCES localidades(loc_codigo),
  loc_nombre  VARCHAR(50),
  upl_codigo  VARCHAR(10)                REFERENCES upz(upl_codigo),
  upl_nombre  VARCHAR(50),
  sca_codigo  CHAR(6)                    REFERENCES sectores_catastrales(sca_codigo),
  sca_nombre  VARCHAR(60),
  cai_codigo  VARCHAR(10),
  pcu_codigo  VARCHAR(10),
  pcu_nombre  VARCHAR(50),
  geom        GEOMETRY(MULTIPOLYGON, 4326),
  updated_at  TIMESTAMPTZ                DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_entornos_geom    ON entornos USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_entornos_pcu     ON entornos(pcu_codigo);
CREATE INDEX IF NOT EXISTS idx_entornos_sca     ON entornos(sca_codigo);
CREATE INDEX IF NOT EXISTS idx_entornos_hiunico ON entornos(hiunico);

-- Tabla de staging para swap atómico durante sync S9.
-- Recibe los 59,384 registros nuevos antes de validar y reemplazar entornos.
CREATE TABLE IF NOT EXISTS entornos_staging (
  objectid    INTEGER,
  hiunico     INTEGER,
  loc_codigo  CHAR(2),
  loc_nombre  VARCHAR(50),
  upl_codigo  VARCHAR(10),
  upl_nombre  VARCHAR(50),
  sca_codigo  CHAR(6),
  sca_nombre  VARCHAR(60),
  cai_codigo  VARCHAR(10),
  pcu_codigo  VARCHAR(10),
  pcu_nombre  VARCHAR(50),
  geom        GEOMETRY(MULTIPOLYGON, 4326)
);
CREATE INDEX IF NOT EXISTS idx_entornos_staging_geom ON entornos_staging USING GIST(geom);


-- ============================================================
-- 9. delitos_hurto_motos — 21 filas (una por localidad)
--    Histórico 2018-2026. Variables f₁ y f₂ del ARU.
-- ============================================================
CREATE TABLE IF NOT EXISTS delitos_hurto_motos (
  loc_codigo    CHAR(2)                  PRIMARY KEY REFERENCES localidades(loc_codigo),
  loc_nombre    VARCHAR(50),
  hm_2018       INTEGER                  DEFAULT 0,
  hm_2019       INTEGER                  DEFAULT 0,
  hm_2020       INTEGER                  DEFAULT 0,
  hm_2021       INTEGER                  DEFAULT 0,
  hm_2022       INTEGER                  DEFAULT 0,
  hm_2023       INTEGER                  DEFAULT 0,
  hm_2024       INTEGER                  DEFAULT 0,
  hm_2025       INTEGER                  DEFAULT 0,
  hm_2026       INTEGER                  DEFAULT 0,
  hm_variacion  DOUBLE PRECISION,
  hm_total_anio INTEGER                  DEFAULT 0,
  synced_at     TIMESTAMPTZ              DEFAULT now()
);


-- ============================================================
-- 10. incidentes_nuse — por sector catastral
--     Incidentes NUSE (123): riñas, narco, orden público,
--     disparos, porte ilegal, hurtos. Variables f₃-f₆ del ARU.
--     NOTA: nombres de campos verificar contra FeatureServer/7
--     antes del primer sync. Pueden variar del patrón CMxx26CONT.
-- ============================================================
CREATE TABLE IF NOT EXISTS incidentes_nuse (
  sca_codigo          CHAR(6)            PRIMARY KEY REFERENCES sectores_catastrales(sca_codigo),
  sca_nombre          VARCHAR(60),
  nuse_rina_2025      INTEGER            DEFAULT 0,
  nuse_narco_2025     INTEGER            DEFAULT 0,
  nuse_orden_2025     INTEGER            DEFAULT 0,
  nuse_maltrato_2025  INTEGER            DEFAULT 0,
  nuse_disparo_2025   INTEGER            DEFAULT 0,
  nuse_porte_2025     INTEGER            DEFAULT 0,
  nuse_hurto_2025     INTEGER            DEFAULT 0,
  nuse_rina_2026      INTEGER            DEFAULT 0,
  nuse_narco_2026     INTEGER            DEFAULT 0,
  nuse_orden_2026     INTEGER            DEFAULT 0,
  nuse_maltrato_2026  INTEGER            DEFAULT 0,
  nuse_disparo_2026   INTEGER            DEFAULT 0,
  nuse_porte_2026     INTEGER            DEFAULT 0,
  nuse_hurto_2026     INTEGER            DEFAULT 0,
  nuse_total_2026     INTEGER            DEFAULT 0,
  synced_at           TIMESTAMPTZ        DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nuse_sca ON incidentes_nuse(sca_codigo);


-- ============================================================
-- 11. rnmc — Registro Novedades Modelo de Ciudad por sector
--     Estructura normalizada: 1 fila por (sector, artículo, mes).
--     Variables f₄-f₆ del ARU (disparos, porte armas, orden público).
-- ============================================================
CREATE TABLE IF NOT EXISTS rnmc (
  id           SERIAL                    PRIMARY KEY,
  sca_codigo   CHAR(6)                   REFERENCES sectores_catastrales(sca_codigo),
  sca_nombre   VARCHAR(60),
  articulo     VARCHAR(20),
  num_articulo INTEGER,
  descripcion  TEXT,
  mes          VARCHAR(20),
  conteo       INTEGER                   DEFAULT 0,
  total        INTEGER                   DEFAULT 0,
  synced_at    TIMESTAMPTZ               DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rnmc_sca       ON rnmc(sca_codigo);
CREATE INDEX IF NOT EXISTS idx_rnmc_sca_total ON rnmc(sca_codigo, conteo DESC);


-- ============================================================
-- HEATMAPS — tablas de scores calculados (poblar en Fase 2)
-- ============================================================
CREATE TABLE IF NOT EXISTS argus_heatmap_historico (
  id             SERIAL                  PRIMARY KEY,
  geom           GEOMETRY(POLYGON, 4326),
  sector_cod     VARCHAR(10),
  upz_cod        VARCHAR(6),
  localidad_cod  VARCHAR(2),
  h_score        FLOAT8,
  h_score_raw    FLOAT8,
  h_motos        FLOAT8,
  h_hurto        FLOAT8,
  h_disparos     FLOAT8,
  h_armas        FLOAT8,
  periodo_inicio DATE,
  periodo_fin    DATE,
  version        INT,
  computed_at    TIMESTAMPTZ             DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_heatmap_hist_geom   ON argus_heatmap_historico USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_heatmap_hist_score  ON argus_heatmap_historico(h_score DESC);
CREATE INDEX IF NOT EXISTS idx_heatmap_hist_sector ON argus_heatmap_historico(sector_cod);

CREATE TABLE IF NOT EXISTS argus_heatmap_semanal (
  id            BIGSERIAL               PRIMARY KEY,
  geom          GEOMETRY(POLYGON, 4326),
  entorno_id    INT,
  h_score       FLOAT8,
  eventos_count INT,
  week_start    DATE,
  computed_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_heatmap_sem_geom   ON argus_heatmap_semanal USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_heatmap_sem_score  ON argus_heatmap_semanal(h_score DESC);
CREATE INDEX IF NOT EXISTS idx_heatmap_sem_expire ON argus_heatmap_semanal(expires_at);

CREATE TABLE IF NOT EXISTS argus_perfil_temporal_zona (
  id          SERIAL                    PRIMARY KEY,
  entorno_id  INT                       REFERENCES entornos(objectid),
  hora        SMALLINT,
  dia_semana  SMALLINT,
  risk_factor FLOAT8,
  sample_size INT,
  updated_at  TIMESTAMPTZ
);


-- ============================================================
-- gis_sync_log — historial de sincronizaciones
-- ============================================================
CREATE TABLE IF NOT EXISTS gis_sync_log (
  id             SERIAL                  PRIMARY KEY,
  job_name       VARCHAR(30)             NOT NULL,
  status         VARCHAR(10)             NOT NULL CHECK (status IN ('started', 'success', 'failed')),
  records_synced INTEGER,
  duration_ms    INTEGER,
  error_msg      TEXT,
  synced_at      TIMESTAMPTZ             NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_synclog_job ON gis_sync_log(job_name, synced_at DESC);


-- ============================================================
-- mv_risk_sector — vista materializada para queries de riesgo
-- Se refresca mensualmente después de sync P2 (incidentes_nuse).
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_risk_sector;
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_risk_sector AS
SELECT
  s.sca_codigo,
  s.geom,
  COALESCE(n.nuse_hurto_2026,   0) AS nuse_hurto,
  COALESCE(n.nuse_disparo_2026, 0) AS nuse_disparo,
  COALESCE(n.nuse_rina_2026,    0) AS nuse_rina,
  COALESCE(n.nuse_total_2026,   0) AS nuse_total
FROM sectores_catastrales s
LEFT JOIN incidentes_nuse n ON n.sca_codigo = s.sca_codigo;

CREATE INDEX IF NOT EXISTS idx_mv_risk_sector_geom ON mv_risk_sector USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_mv_risk_sector_code ON mv_risk_sector(sca_codigo);


-- ============================================================
-- argus_lookup(lon, lat) — función principal de lookup espacial
--
-- Dado un punto WGS84, devuelve la jerarquía completa:
--   localidad → UPZ → sector → cuadrante → CAI + teléfono patrullero
--
-- Uso: SELECT * FROM argus_lookup(-74.1002, 4.6234);
-- Latencia objetivo: p99 < 100ms (PostGIS) | p99 < 30ms (Redis hit en Fase 1)
-- ============================================================
CREATE OR REPLACE FUNCTION argus_lookup(
  p_lon DOUBLE PRECISION,
  p_lat DOUBLE PRECISION
)
RETURNS TABLE(
  loc_codigo   CHAR(2),
  loc_nombre   VARCHAR,
  upl_codigo   VARCHAR,
  upl_nombre   VARCHAR,
  sca_codigo   CHAR(6),
  sca_nombre   VARCHAR,
  pcu_codigo   VARCHAR,
  pcu_nombre   VARCHAR,
  pcu_telefono VARCHAR,
  cai_codigo   VARCHAR,
  hiunico      INTEGER
) AS $$
  SELECT
    e.loc_codigo, e.loc_nombre,
    e.upl_codigo, e.upl_nombre,
    e.sca_codigo, e.sca_nombre,
    e.pcu_codigo, e.pcu_nombre,
    c.pcu_telefono,
    e.cai_codigo,
    e.hiunico
  FROM entornos e
  LEFT JOIN cuadrantes c ON c.pcu_codigo = e.pcu_codigo
  WHERE ST_Contains(e.geom, ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326))
  LIMIT 1;
$$ LANGUAGE sql STABLE;
