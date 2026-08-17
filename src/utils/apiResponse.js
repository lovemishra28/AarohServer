class ApiResponse {
  static success(res, message = 'Success', data = null, statusCode = 200, extra = {}) {
    return res.status(statusCode).json({
      success: true,
      message,
      data,
      ...extra
    });
  }

  static created(res, message = 'Resource created successfully', data = null, extra = {}) {
    return this.success(res, message, data, 201, extra);
  }

  static error(res, message = 'An error occurred', statusCode = 500, errors = []) {
    return res.status(statusCode).json({
      success: false,
      message,
      errors: errors.length ? errors : undefined
    });
  }
}

module.exports = ApiResponse;
