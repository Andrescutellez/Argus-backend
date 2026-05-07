// Importamos Router de Express para definir rutas de forma modular
const { Router } = require("express");

// Importamos las funciones del controlador
const { guardarDato, obtenerDatos, getLatestByDevice } = require('../controllers/gpsController');

const router = Router();

router.post('/', guardarDato);
router.get('/', obtenerDatos);
router.get('/:deviceId/latest', getLatestByDevice);

module.exports = router;
