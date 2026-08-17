const express = require('express');
const { body } = require('express-validator');
const {
  signupEmail,
  loginEmail,
  requestMobileOtp,
  verifyMobileOtpAndAuth,
  continueWithGoogle,
  getMe
} = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');
const validate = require('../middlewares/validateMiddleware');

const router = express.Router();

// 1. Email Sign Up
router.post(
  '/email/signup',
  [
    body('name')
      .trim()
      .notEmpty().withMessage('Name is required')
      .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),
    body('age')
      .optional()
      .isInt({ min: 1, max: 120 }).withMessage('Age must be an integer between 1 and 120'),
    body('email')
      .trim()
      .isEmail().withMessage('Please provide a valid email address')
      .normalizeEmail(),
    body('password')
      .isLength({ min: 6 }).withMessage('Password must be at least 6 characters long'),
    validate
  ],
  signupEmail
);

// 2. Email Login
router.post(
  '/email/login',
  [
    body('email')
      .trim()
      .isEmail().withMessage('Please provide a valid email address')
      .normalizeEmail(),
    body('password')
      .notEmpty().withMessage('Password is required'),
    validate
  ],
  loginEmail
);

// 3. Request Mobile OTP
router.post(
  '/otp/send',
  [
    body('phone')
      .trim()
      .notEmpty().withMessage('Phone number is required')
      .matches(/^[0-9+-\s()]{7,15}$/).withMessage('Please provide a valid phone number (7-15 digits)'),
    validate
  ],
  requestMobileOtp
);

// 4. Verify Mobile OTP & Auth
router.post(
  '/otp/verify',
  [
    body('phone')
      .trim()
      .notEmpty().withMessage('Phone number is required'),
    body('otp')
      .trim()
      .notEmpty().withMessage('OTP is required')
      .isLength({ min: 4, max: 8 }).withMessage('OTP must be between 4 and 8 digits'),
    body('name')
      .optional()
      .trim()
      .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),
    body('age')
      .optional()
      .isInt({ min: 1, max: 120 }).withMessage('Age must be an integer between 1 and 120'),
    validate
  ],
  verifyMobileOtpAndAuth
);

// 5. Continue with Google (Android Google Sign-In)
router.post(
  '/google',
  [
    body('idToken')
      .trim()
      .notEmpty().withMessage('Google ID token is required'),
    body('age')
      .optional()
      .isInt({ min: 1, max: 120 }).withMessage('Age must be an integer between 1 and 120'),
    validate
  ],
  continueWithGoogle
);

// 6. Get Current Authenticated Profile
router.get('/me', protect, getMe);

module.exports = router;
