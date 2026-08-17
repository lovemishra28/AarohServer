const express = require('express');
const { body, param, query } = require('express-validator');
const {
  recordTelemetry,
  getLatestReadings,
  getDeviceHistory
} = require('../controllers/sensorDataController');
const { protect } = require('../middlewares/authMiddleware');
const validate = require('../middlewares/validateMiddleware');

const router = express.Router();

router.use(protect);

// Record Telemetry Data from Device / App
router.post(
  '/',
  [
    body('deviceId')
      .trim()
      .notEmpty().withMessage('deviceId is required'),
    body('soilMoisture')
      .optional()
      .isFloat({ min: 0, max: 100 }).withMessage('soilMoisture must be between 0 and 100'),
    body('soilTemperature')
      .optional()
      .isFloat().withMessage('soilTemperature must be a valid number'),
    body('soilPh')
      .optional()
      .isFloat({ min: 0, max: 14 }).withMessage('soilPh must be between 0 and 14'),
    validate
  ],
  recordTelemetry
);

// Get Latest Readings (Dashboard)
router.get('/latest', getLatestReadings);

// Get History Time-series (Android Charts)
router.get(
  '/history/:deviceId',
  [
    param('deviceId').trim().notEmpty().withMessage('deviceId parameter is required'),
    query('range').optional().isIn(['24h', '7d', '30d']).withMessage('Range must be 24h, 7d, or 30d'),
    validate
  ],
  getDeviceHistory
);

module.exports = router;
