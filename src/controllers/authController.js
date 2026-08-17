const User = require('../models/User');
const { generateToken } = require('../services/tokenService');
const { sendOtp, verifyOtp } = require('../services/otpService');
const { verifyGoogleToken } = require('../services/googleAuthService');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

/**
 * @desc    1. Sign up using Email & Password
 * @route   POST /api/v1/auth/email/signup
 * @access  Public
 */
const signupEmail = async (req, res, next) => {
  try {
    const { name, age, email, password, role, farmDetails } = req.body;

    // Check if user already exists with this email
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      throw new ApiError('An account with this email address already exists. Please login instead.', 409);
    }

    // Create user
    const user = await User.create({
      name,
      age: age ? Number(age) : undefined,
      email: email.toLowerCase(),
      password,
      role: role || 'farmer',
      authProvider: 'email',
      farmDetails: farmDetails || {},
      isVerified: false
    });

    // Generate JWT token
    const token = generateToken(user._id, user.role);

    return ApiResponse.created(res, 'User registered successfully via Email', {
      user,
      token
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    2. Login using Email & Password
 * @route   POST /api/v1/auth/email/login
 * @access  Public
 */
const loginEmail = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Find user with password field included
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');

    if (!user) {
      throw new ApiError('Invalid email or password credentials.', 401);
    }

    if (user.authProvider !== 'email' && !user.password) {
      throw new ApiError(`This account was registered using ${user.authProvider}. Please sign in using ${user.authProvider}.`, 400);
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      throw new ApiError('Invalid email or password credentials.', 401);
    }

    if (!user.isActive) {
      throw new ApiError('Your account has been deactivated.', 403);
    }

    const token = generateToken(user._id, user.role);

    return ApiResponse.success(res, 'Login successful', {
      user,
      token
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    3. Request Mobile OTP
 * @route   POST /api/v1/auth/otp/send
 * @access  Public
 */
const requestMobileOtp = async (req, res, next) => {
  try {
    const { phone } = req.body;

    const result = await sendOtp(phone);

    return ApiResponse.success(
      res,
      `Verification OTP sent successfully to ${phone}`,
      result
    );
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    4. Verify Mobile OTP and Login/Signup
 * @route   POST /api/v1/auth/otp/verify
 * @access  Public
 */
const verifyMobileOtpAndAuth = async (req, res, next) => {
  try {
    const { phone, otp, name, age, role, farmDetails } = req.body;

    // Verify OTP
    await verifyOtp(phone, otp);

    // Check if user already exists
    let user = await User.findOne({ phone });
    let isNewUser = false;

    if (!user) {
      // New user signup via phone
      isNewUser = true;
      user = await User.create({
        name: name || `Farmer_${phone.slice(-4)}`,
        age: age ? Number(age) : undefined,
        phone,
        authProvider: 'phone',
        role: role || 'farmer',
        isVerified: true,
        farmDetails: farmDetails || {}
      });
    } else {
      // Existing user login - update name/age if provided
      if (name) user.name = name;
      if (age) user.age = Number(age);
      user.isVerified = true;
      await user.save();
    }

    const token = generateToken(user._id, user.role);

    return ApiResponse.success(
      res,
      isNewUser ? 'Account created and verified successfully' : 'Mobile login successful',
      {
        user,
        isNewUser,
        token
      }
    );
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    5. Continue with Google (Android Google Sign-In)
 * @route   POST /api/v1/auth/google
 * @access  Public
 */
const continueWithGoogle = async (req, res, next) => {
  try {
    const { idToken, name: inputName, age, farmDetails } = req.body;

    // Verify token with Google
    const googlePayload = await verifyGoogleToken(idToken);
    const { googleId, email, name: googleName, picture } = googlePayload;

    // Find existing user by googleId or email
    let user = await User.findOne({
      $or: [{ googleId }, { email: email.toLowerCase() }]
    });

    let isNewUser = false;

    if (!user) {
      // Create new user from Google profile
      isNewUser = true;
      user = await User.create({
        name: inputName || googleName || 'Google User',
        age: age ? Number(age) : undefined,
        email: email.toLowerCase(),
        googleId,
        avatar: picture || '',
        authProvider: 'google',
        role: 'farmer',
        isVerified: true,
        farmDetails: farmDetails || {}
      });
    } else {
      // Existing user - link Google ID if needed
      if (!user.googleId) {
        user.googleId = googleId;
      }
      if (!user.avatar && picture) {
        user.avatar = picture;
      }
      if (age && !user.age) {
        user.age = Number(age);
      }
      user.isVerified = true;
      await user.save();
    }

    const token = generateToken(user._id, user.role);

    return ApiResponse.success(
      res,
      isNewUser ? 'Account registered successfully with Google' : 'Google login successful',
      {
        user,
        isNewUser,
        token
      }
    );
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    6. Get Current Authenticated User Profile
 * @route   GET /api/v1/auth/me
 * @access  Private (Bearer Token required)
 */
const getMe = async (req, res, next) => {
  try {
    return ApiResponse.success(res, 'User profile retrieved', {
      user: req.user
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  signupEmail,
  loginEmail,
  requestMobileOtp,
  verifyMobileOtpAndAuth,
  continueWithGoogle,
  getMe
};
