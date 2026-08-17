const mongoose = require('mongoose');
const crypto = require('crypto');

const deviceSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: [true, 'Device ID is required'],
    unique: true,
    trim: true,
    uppercase: true
  },
  deviceName: {
    type: String,
    required: [true, 'Device Name is required'],
    trim: true,
    default: 'Aaroh Field Sensor'
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Device must be linked to a user/farmer'],
    index: true
  },
  deviceType: {
    type: String,
    enum: ['soil_node', 'weather_station', 'irrigation_controller', 'multisensor_hub'],
    default: 'soil_node'
  },
  farmSection: {
    type: String,
    trim: true,
    default: 'Main Plot'
  },
  apiKey: {
    type: String,
    unique: true,
    select: false
  },
  status: {
    type: String,
    enum: ['online', 'offline', 'warning', 'maintenance'],
    default: 'offline'
  },
  batteryPercentage: {
    type: Number,
    min: 0,
    max: 100,
    default: 100
  },
  signalStrengthDbm: {
    type: Number,
    default: -70
  },
  location: {
    latitude: { type: Number },
    longitude: { type: Number }
  },
  thresholds: {
    soilMoistureMin: { type: Number, default: 20 }, // Percentage
    soilMoistureMax: { type: Number, default: 80 },
    soilTempMin: { type: Number, default: 10 },     // Celsius
    soilTempMax: { type: Number, default: 40 },
    phMin: { type: Number, default: 5.5 },
    phMax: { type: Number, default: 7.5 }
  },
  lastPingAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Auto-generate apiKey if not set
deviceSchema.pre('save', function (next) {
  if (!this.apiKey) {
    this.apiKey = 'aaroh_dev_' + crypto.randomBytes(16).toString('hex');
  }
  next();
});

const Device = mongoose.model('Device', deviceSchema);

module.exports = Device;
