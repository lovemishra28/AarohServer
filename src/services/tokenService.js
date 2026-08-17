const jwt = require('jsonwebtoken');
const env = require('../config/env');

const generateToken = (userId, role = 'farmer') => {
  return jwt.sign(
    { id: userId, role },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRE }
  );
};

const verifyToken = (token) => {
  return jwt.verify(token, env.JWT_SECRET);
};

module.exports = {
  generateToken,
  verifyToken
};
