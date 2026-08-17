const Otp = require('../models/Otp');
const env = require('../config/env');
const ApiError = require('../utils/apiError');

/**
 * Generate a random N-digit OTP code
 */
const generateOtpCode = (length = 6) => {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * 10)];
  }
  return otp;
};

/**
 * Send SMS via configured SMS provider
 */
const dispatchSms = async (phone, otpCode) => {
  if (env.SMS_PROVIDER === 'twilio' && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    try {
      const twilio = require('twilio')(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
      await twilio.messages.create({
        body: `Your Aaroh Agriculture verification code is: ${otpCode}. Valid for ${env.OTP_TTL_MINUTES} minutes.`,
        from: env.TWILIO_PHONE_NUMBER,
        to: phone
      });
      console.log(`[SMS Service] Twilio OTP sent to ${phone}`);
    } catch (err) {
      console.error(`[SMS Service] Twilio dispatch failed: ${err.message}`);
      throw new ApiError('Failed to send SMS OTP via Twilio', 500);
    }
  } else {
    // Development / Mock mode
    console.log(`\n======================================================`);
    console.log(`[MOCK SMS] OTP for ${phone} is: [ ${otpCode} ]`);
    console.log(`Valid for ${env.OTP_TTL_MINUTES} minutes.`);
    console.log(`======================================================\n`);
  }
};

/**
 * Generate, save, and dispatch OTP to mobile phone
 */
const sendOtp = async (phone) => {
  // Clear any existing active OTP for this phone
  await Otp.deleteMany({ phone });

  // Generate new OTP (or use DEFAULT_DEV_OTP if specified)
  const otpCode = generateOtpCode(env.OTP_LENGTH);

  // Store in MongoDB
  await Otp.create({
    phone,
    otp: otpCode
  });

  // Dispatch SMS
  await dispatchSms(phone, otpCode);

  return {
    phone,
    expiresInMinutes: env.OTP_TTL_MINUTES,
    // Include devOtp only in development mode for easy testing by frontend devs
    devOtp: env.NODE_ENV === 'development' ? otpCode : undefined
  };
};

/**
 * Verify phone and entered OTP
 */
const verifyOtp = async (phone, enteredOtp) => {
  const record = await Otp.findOne({ phone }).sort({ createdAt: -1 });

  if (!record) {
    throw new ApiError('OTP expired or not requested for this phone number. Please request a new OTP.', 400);
  }

  if (record.attempts >= 5) {
    await Otp.deleteOne({ _id: record._id });
    throw new ApiError('Too many failed attempts. Please request a new OTP.', 429);
  }

  // Check matching OTP or dev master bypass in non-production
  const isValid = (record.otp === enteredOtp.trim()) || (env.NODE_ENV === 'development' && enteredOtp === env.DEFAULT_DEV_OTP);

  if (!isValid) {
    record.attempts += 1;
    await record.save();
    throw new ApiError('Invalid OTP code. Please check and try again.', 400);
  }

  // OTP verified successfully, clean up record
  await Otp.deleteOne({ _id: record._id });

  return true;
};

module.exports = {
  sendOtp,
  verifyOtp
};
