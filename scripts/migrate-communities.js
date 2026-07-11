/**
 * @fileoverview Migración: tablas del sistema de comunidades Argus.
 * Ejecutar UNA SOLA VEZ en el servidor: node scripts/migrate-communities.js
 */
'use strict';
require('dotenv').config();
const { initPostgres, getPool } = require('../config/postgres');

const SQL = `
-- ─── Comunidades ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS communities (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(100) NOT NULL,
  description  TEXT,
  image_url    VARCHAR(500),
  type         VARCHAR(30)  NOT NULL DEFAULT 'CLUB',
  privacy      VARCHAR(20)  NOT NULL DEFAULT 'PRIVADA',
  owner_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_count INT          NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Membresía + roles ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_members (
  community_id UUID        NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  role         VARCHAR(20) NOT NULL DEFAULT 'MEMBER',
  status       VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (community_id, user_id)
);

-- ─── Invitaciones por token ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_invitations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID        NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  token        VARCHAR(32) UNIQUE NOT NULL,
  created_by   UUID        NOT NULL REFERENCES users(id),
  expires_at   TIMESTAMPTZ,
  max_uses     INT,
  use_count    INT         NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Configuración por comunidad ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_settings (
  community_id       UUID    PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
  alert_on_theft     BOOLEAN NOT NULL DEFAULT TRUE,
  alert_on_risk_zone BOOLEAN NOT NULL DEFAULT FALSE,
  allow_sightings    BOOLEAN NOT NULL DEFAULT TRUE
);

-- ─── Feed de publicaciones ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_posts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID        NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  author_id    UUID        NOT NULL REFERENCES users(id),
  type         VARCHAR(30) NOT NULL DEFAULT 'GENERAL',
  content      TEXT        NOT NULL,
  media_url    VARCHAR(500),
  incident_id  UUID,
  lat          DOUBLE PRECISION,
  lng          DOUBLE PRECISION,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Preferencias de privacidad en users ──────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS
  share_theft_with_communities BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS
  theft_location_visibility VARCHAR(20) NOT NULL DEFAULT 'last_known';

-- ─── Índices de rendimiento ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_community_members_user    ON community_members(user_id);
CREATE INDEX IF NOT EXISTS idx_community_members_comm    ON community_members(community_id, status);
CREATE INDEX IF NOT EXISTS idx_community_posts_community ON community_posts(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_communities_privacy       ON communities(privacy);
`;

(async () => {
  await initPostgres();
  await getPool().query(SQL);
  console.log('✅ Migración de comunidades aplicada correctamente.');
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
