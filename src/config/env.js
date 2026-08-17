require('dotenv').config();

const env = {
  PORT: process.env.PORT || 5000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aaroh_agriculture_db',
  JWT_SECRET: process.env.JWT_SECRET || 'aaroh_default_jwt_secret_key_2026',
  JWT_EXPIRE: process.env.JWT_EXPIRE || '30d',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  OTP_TTL_MINUTES: parseInt(process.env.OTP_TTL_MINUTES, 10) || 5,
  OTP_LENGTH: parseInt(process.env.OTP_LENGTH, 10) || 6,
  DEFAULT_DEV_OTP: process.env.DEFAULT_DEV_OTP || '123456',
  SMS_PROVIDER: process.env.SMS_PROVIDER || 'mock',
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER || ''
};

module.exports = env;
