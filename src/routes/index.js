const express = require('express');
const authRoutes = require('./authRoutes');
const userRoutes = require('./userRoutes');
const deviceRoutes = require('./deviceRoutes');
const sensorDataRoutes = require('./sensorDataRoutes');

const router = express.Router();

// Mount Feature Routes
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/devices', deviceRoutes);
router.use('/sensor-data', sensorDataRoutes);

// API Status Route
router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Aaroh Agriculture API v1 is operational',
    version: '1.0.0',
    endpoints: {
      auth: '/api/v1/auth',
      users: '/api/v1/users',
      devices: '/api/v1/devices',
      sensorData: '/api/v1/sensor-data'
    }
  });
});

module.exports = router;
