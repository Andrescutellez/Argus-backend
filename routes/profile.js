'use strict';
const { Router } = require('express');
const auth = require('../middleware/auth');
const {
  getMe, updateMe, changeUsername, checkUsername, getPublic,
} = require('../controllers/profileController');

const router = Router();

// Todas las rutas requieren autenticación
router.use(auth);

// IMPORTANTE: rutas estáticas ANTES que /:username para evitar conflictos
router.get('/me',                getMe);
router.patch('/me',              updateMe);
router.patch('/me/username',     changeUsername);
router.get('/check/:username',   checkUsername);

// Ruta paramétrica al final
router.get('/:username',         getPublic);

module.exports = router;
