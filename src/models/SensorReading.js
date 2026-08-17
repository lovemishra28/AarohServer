const mongoose = require('mongoose');

const sensorReadingSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: [true, 'Device ID is required'],
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  // Soil Metrics
  soilMoisture: {
    type: Number, // Percentage 0 - 100%
    min: 0,
    max: 100
  },
  soilTemperature: {
    type: Number // Celsius
  },
  soilPh: {
    type: Number, // 0 - 14
    min: 0,
    max: 14
  },
  // NPK Soil Nutrients (mg/kg)
  nitrogen: {
    type: Number,
    min: 0
  },
  phosphorus: {
    type: Number,
    min: 0
  },
  potassium: {
    type: Number,
    min: 0
  },
  electricalConductivity: {
    type: Number, // uS/cm
    min: 0
  },
  // Environmental / Atmospheric Metrics
  ambientTemperature: {
    type: Number // Celsius
  },
  ambientHumidity: {
    type: Number, // Percentage 0 - 100%
    min: 0,
    max: 100
  },
  sunlightLux: {
    type: Number, // Lux
    min: 0
  },
  rainfallMm: {
    type: Number,
    min: 0,
    default: 0
  },
  // Diagnostics
  batteryLevel: {
    type: Number,
    min: 0,
    max: 100
  },
  recordedAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// Compound indexes for time-series queries
sensorReadingSchema.index({ deviceId: 1, recordedAt: -1 });
sensorReadingSchema.index({ userId: 1, recordedAt: -1 });

const SensorReading = mongoose.model('SensorReading', sensorReadingSchema);

module.exports = SensorReading;
