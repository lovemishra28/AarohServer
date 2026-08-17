const express = require('express');
const { body } = require('express-validator');
const { updateProfile, changePassword } = require('../controllers/userController');
const { protect } = require('../middlewares/authMiddleware');
const validate = require('../middlewares/validateMiddleware');

const router = express.Router();

// Apply auth middleware to all user routes
router.use(protect);

// Update Profile
router.put(
  '/profile',
  [
    body('name')
      .optional()
      .trim()
      .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),
    body('age')
      .optional()
      .isInt({ min: 1, max: 120 }).withMessage('Age must be an integer between 1 and 120'),
    validate
  ],
  updateProfile
);

// Change Password
router.put(
  '/change-password',
  [
    body('currentPassword')
      .notEmpty().withMessage('Current password is required'),
    body('newPassword')
      .isLength({ min: 6 }).withMessage('New password must be at least 6 characters long'),
    validate
  ],
  changePassword
);

module.exports = router;
