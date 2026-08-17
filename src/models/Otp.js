const mongoose = require('mongoose');
const env = require('../config/env');

const otpSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    index: true,
    trim: true
  },
  otp: {
    type: String,
    required: true
  },
  attempts: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: env.OTP_TTL_MINUTES * 60 // Documents auto-expire after TTL in seconds
  }
});

const Otp = mongoose.model('Otp', otpSchema);

module.exports = Otp;
