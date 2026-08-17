const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const env = require('../config/env');

const notFound = (req, res, next) => {
  const err = new ApiError(`Route not found: ${req.method} ${req.originalUrl}`, 404);
  next(err);
};

const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;
  let statusCode = err.statusCode || 500;
  let errors = err.errors || [];

  // Log full error stack in development
  if (env.NODE_ENV === 'development') {
    console.error(`[Error] ${req.method} ${req.originalUrl}:`, err);
  }

  // Mongoose Bad ObjectId (CastError)
  if (err.name === 'CastError') {
    const message = `Resource not found with id: ${err.value}`;
    error = new ApiError(message, 404);
    statusCode = 404;
  }

  // Mongoose Duplicate Key Error (Code 11000)
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    const value = err.keyValue ? err.keyValue[field] : '';
    const message = `An account with this ${field} ('${value}') already exists. Please login or use a different ${field}.`;
    statusCode = 409;
    error = new ApiError(message, 409);
  }

  // Mongoose Validation Error
  if (err.name === 'ValidationError') {
    const message = 'Database Validation Error';
    errors = Object.values(err.errors).map(val => ({
      field: val.path,
      message: val.message
    }));
    statusCode = 400;
    error = new ApiError(message, 400, errors);
  }

  return ApiResponse.error(
    res,
    error.message || 'Internal Server Error',
    statusCode,
    errors
  );
};

module.exports = {
  notFound,
  errorHandler
};
