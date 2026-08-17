const User = require('../models/User');
const { verifyToken } = require('../services/tokenService');
const ApiError = require('../utils/apiError');

/**
 * Protect routes: verifies Bearer JWT token from Authorization header
 */
const protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return next(new ApiError('Authentication token missing. Please provide a Bearer token in the Authorization header.', 401));
    }

    // Verify token
    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return next(new ApiError('Token expired. Please login again.', 401));
      }
      return next(new ApiError('Invalid authentication token.', 401));
    }

    // Find user in database
    const user = await User.findById(decoded.id);

    if (!user) {
      return next(new ApiError('The user belonging to this token no longer exists.', 401));
    }

    if (!user.isActive) {
      return next(new ApiError('Your account has been deactivated. Please contact support.', 403));
    }

    // Attach user to request object
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Restrict routes to specific roles (e.g. farmer, agronomist, admin)
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new ApiError(`Role '${req.user ? req.user.role : 'anonymous'}' is not authorized to access this resource`, 403));
    }
    next();
  };
};

module.exports = {
  protect,
  authorize
};
