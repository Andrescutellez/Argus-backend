'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { getMySubscription } = require('../controllers/subscriptionController');

const router = Router();

router.get('/me', authenticate, getMySubscription);

module.exports = router;
