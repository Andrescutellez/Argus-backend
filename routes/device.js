const { Router } = require('express');
const { getDeviceStatus, postCommand } = require('../controllers/deviceController');

const router = Router();

router.get('/:deviceId/status', getDeviceStatus);
router.post('/:deviceId/command', postCommand);

module.exports = router;
