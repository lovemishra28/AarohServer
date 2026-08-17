const { OAuth2Client } = require('google-auth-library');
const env = require('../config/env');
const ApiError = require('../utils/apiError');

const client = new OAuth2Client(env.GOOGLE_CLIENT_ID);

/**
 * Verify Google ID Token received from Android Google Sign-In Client
 * @param {string} idToken - The Google ID Token from Android app
 * @returns {Promise<{googleId: string, email: string, name: string, picture: string}>}
 */
const verifyGoogleToken = async (idToken) => {
  if (!idToken) {
    throw new ApiError('Google ID Token is required', 400);
  }

  // Development mock token support for local testing without real Android Google Play services
  if (env.NODE_ENV === 'development' && idToken.startsWith('mock_google_token_')) {
    const mockEmail = idToken.replace('mock_google_token_', '') + '@gmail.com';
    return {
      googleId: 'mock_gid_' + idToken,
      email: mockEmail,
      name: 'Google Test User',
      picture: 'https://lh3.googleusercontent.com/a/default-user=s96-c'
    };
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_ID ? [env.GOOGLE_CLIENT_ID] : undefined
    });

    const payload = ticket.getPayload();

    if (!payload) {
      throw new ApiError('Invalid Google Token payload', 401);
    }

    return {
      googleId: payload.sub,
      email: payload.email,
      name: payload.name || payload.given_name || 'Google User',
      picture: payload.picture || ''
    };
  } catch (error) {
    console.error(`[GoogleAuth] Token verification failed: ${error.message}`);
    throw new ApiError('Google token verification failed: ' + error.message, 401);
  }
};

module.exports = {
  verifyGoogleToken
};
