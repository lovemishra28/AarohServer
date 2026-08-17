/**
 * Aaroh Agriculture Server - Fast Unit & Logic Test Suite
 * Validates Token Service, OTP Service, Password Hashing, User Schema methods, and Routes
 */

const { generateToken, verifyToken } = require('../src/services/tokenService');
const { verifyGoogleToken } = require('../src/services/googleAuthService');
const User = require('../src/models/User');
const bcrypt = require('bcryptjs');

let passed = 0;
let failed = 0;

const assert = (condition, msg) => {
  if (condition) {
    console.log(`  ✅ PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${msg}`);
    failed++;
  }
};

const runUnitTests = async () => {
  console.log('\n======================================================');
  console.log('⚡ Running Aaroh Fast Logic & Security Unit Tests');
  console.log('======================================================\n');

  try {
    // 1. Test JWT Generation & Decoding
    console.log('--- 1. Token Service ---');
    const dummyId = '67b370a91e5d3c0012abc999';
    const token = generateToken(dummyId, 'farmer');
    assert(typeof token === 'string' && token.split('.').length === 3, 'generateToken returns valid 3-part JWT');

    const decoded = verifyToken(token);
    assert(decoded.id === dummyId, 'Decoded JWT payload contains correct user ID');
    assert(decoded.role === 'farmer', 'Decoded JWT payload contains correct role');

    // 2. Test Password Hashing with bcrypt
    console.log('\n--- 2. Password Hashing & Comparison ---');
    const rawPassword = 'SecretFarmerPassword123!';
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(rawPassword, salt);

    const isMatch = await bcrypt.compare(rawPassword, hashedPassword);
    const isWrongMatch = await bcrypt.compare('WrongPassword', hashedPassword);

    assert(isMatch === true, 'bcrypt correctly verifies matching password');
    assert(isWrongMatch === false, 'bcrypt rejects invalid password');

    // 3. Test Google Auth Mock Handler
    console.log('\n--- 3. Google Auth Token Verification ---');
    const googleUser = await verifyGoogleToken('mock_google_token_kisan_mitra');
    assert(googleUser.email === 'kisan_mitra@gmail.com', 'Google token extractor returns correct parsed email');
    assert(googleUser.name === 'Google Test User', 'Google token extractor returns correct name');
    assert(googleUser.googleId.startsWith('mock_gid_'), 'Google token extractor returns googleId');

    // 4. Test User Model Schema Validation
    console.log('\n--- 4. User Model Schema Validation ---');
    const testUser = new User({
      name: 'Ramesh Patel',
      age: 45,
      email: 'ramesh.p@example.com',
      authProvider: 'email',
      role: 'farmer',
      farmDetails: {
        farmName: 'Surya Farm',
        totalAreaAcres: 20
      }
    });

    const validationError = testUser.validateSync();
    assert(!validationError, 'User schema passes validation with valid fields');
    assert(testUser.name === 'Ramesh Patel', 'User schema preserves name');
    assert(testUser.age === 45, 'User schema preserves age');
    assert(testUser.farmDetails.totalAreaAcres === 20, 'User schema preserves farm details');

    // 5. Test Invalid Email format validation
    const invalidEmailUser = new User({
      name: 'Test',
      email: 'invalid-email-address',
      authProvider: 'email'
    });
    const emailErr = invalidEmailUser.validateSync();
    assert(emailErr && emailErr.errors.email !== undefined, 'User schema rejects malformed email address');

    // 6. Test App Module Import
    console.log('\n--- 5. Express App Setup ---');
    const app = require('../src/app');
    assert(typeof app.listen === 'function', 'Express application initialized and callable');

    console.log('\n======================================================');
    console.log(`📊 Unit Test Results: ${passed} Passed, ${failed} Failed`);
    console.log('======================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal Unit Test Error:', err);
    process.exit(1);
  }
};

runUnitTests();
