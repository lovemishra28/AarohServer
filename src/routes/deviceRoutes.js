const express = require('express');
const { body, param } = require('express-validator');
const {
  registerDevice,
  getMyDevices,
  getDeviceById,
  updateDevice,
  deleteDevice
} = require('../controllers/deviceController');
const { protect } = require('../middlewares/authMiddleware');
const validate = require('../middlewares/validateMiddleware');

const router = express.Router();

router.use(protect);

// Register New Device
router.post(
  '/',
  [
    body('deviceId')
      .trim()
      .notEmpty().withMessage('deviceId is required'),
    body('deviceName')
      .trim()
      .notEmpty().withMessage('deviceName is required'),
    body('deviceType')
      .optional()
      .isIn(['soil_node', 'weather_station', 'irrigation_controller', 'multisensor_hub'])
      .withMessage('Invalid device type'),
    validate
  ],
  registerDevice
);

// Get All User Devices
router.get('/', getMyDevices);

// Get Device By ID
router.get(
  '/:id',
  [
    param('id').isMongoId().withMessage('Invalid device Mongo ID'),
    validate
  ],
  getDeviceById
);

// Update Device
router.put(
  '/:id',
  [
    param('id').isMongoId().withMessage('Invalid device Mongo ID'),
    validate
  ],
  updateDevice
);

// Delete Device
router.delete(
  '/:id',
  [
    param('id').isMongoId().withMessage('Invalid device Mongo ID'),
    validate
  ],
  deleteDevice
);

module.exports = router;
