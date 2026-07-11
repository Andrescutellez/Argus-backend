'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const c = require('../controllers/communityController');

const router = Router();
router.use(authenticate);

// ── Comunidades ──────────────────────────────────────────────────────────────
router.post  ('/',                       c.createCommunity);
router.get   ('/mine',                   c.getMyCommunities);
router.get   ('/explore',                c.getPublicCommunities);
router.get   ('/feed',                   c.getMyFeed);
router.get   ('/:communityId',           c.getCommunity);
router.patch ('/:communityId',           c.updateCommunity);
router.delete('/:communityId',           c.deleteCommunity);

// ── Membresía ────────────────────────────────────────────────────────────────
router.post  ('/:communityId/join',                        c.joinCommunity);
router.delete('/:communityId/leave',                       c.leaveCommunity);
router.get   ('/:communityId/members',                     c.listMembers);
router.patch ('/:communityId/members/:targetUserId/role',  c.updateMemberRole);
router.delete('/:communityId/members/:targetUserId',       c.removeMember);

// ── Invitaciones ─────────────────────────────────────────────────────────────
router.post  ('/:communityId/invitations',              c.createInvitation);
router.get   ('/:communityId/invitations',              c.listInvitations);
router.delete('/:communityId/invitations/:invitationId',c.revokeInvitation);
router.post  ('/join/:token',                           c.useInvitation);

// ── Posts / Feed ─────────────────────────────────────────────────────────────
router.post  ('/:communityId/posts',          c.createPost);
router.get   ('/:communityId/posts',          c.getCommunityFeed);
router.delete('/:communityId/posts/:postId',  c.deletePost);

// ── Configuración de comunidad ───────────────────────────────────────────────
router.patch ('/:communityId/settings',  c.updateCommunitySettings);

// ── Preferencias de privacidad del usuario ───────────────────────────────────
router.get   ('/privacy/prefs',   c.getPrivacyPrefs);
router.patch ('/privacy/prefs',   c.updatePrivacyPrefs);

module.exports = router;
