/**
 * Aaroh Agriculture Server - End-to-End API Test Suite
 * Tests all 3 Authentication methods, Profile Management, Device Registration, and IoT Telemetry
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const app = require('../src/app');

let mongoServer;
let server;
let baseUrl;

const runTests = async () => {
  console.log('\n========================================================');
  console.log('🧪 Starting Aaroh Agriculture Server Integration Tests');
  console.log('========================================================\n');

  try {
    // 1. Setup in-memory MongoDB
    console.log('[Setup] Starting In-Memory MongoDB...');
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
    console.log('[Setup] Connected to In-Memory MongoDB');

    // 2. Start test server
    const PORT = 5555;
    server = app.listen(PORT);
    baseUrl = `http://127.0.0.1:${PORT}/api/v1`;
    console.log(`[Setup] Test server running at ${baseUrl}\n`);

    let passedCount = 0;
    let failedCount = 0;

    const assert = (condition, testName) => {
      if (condition) {
        console.log(`  ✅ PASS: ${testName}`);
        passedCount++;
      } else {
        console.error(`  ❌ FAIL: ${testName}`);
        failedCount++;
      }
    };

    // ----------------------------------------------------
    // TEST SUITE 1: Email Authentication (Signup & Login)
    // ----------------------------------------------------
    console.log('\n--- 1. Testing Email Authentication ---');

    const emailSignupPayload = {
      name: 'Ramesh Kumar',
      age: 42,
      email: 'ramesh.farmer@example.com',
      password: 'StrongPassword123!',
      farmDetails: {
        farmName: 'Green Meadows Farm',
        totalAreaAcres: 15,
        cropTypes: ['Wheat', 'Mustard', 'Soybean'],
        soilType: 'Alluvial'
      }
    };

    const signupRes = await fetch(`${baseUrl}/auth/email/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(emailSignupPayload)
    });
    const signupData = await signupRes.json();

    assert(signupRes.status === 201, 'Email Signup status code is 201');
    assert(signupData.success === true, 'Email Signup response success is true');
    assert(signupData.data.user.name === 'Ramesh Kumar', 'Email Signup saves Name correctly');
    assert(signupData.data.user.age === 42, 'Email Signup saves Age correctly');
    assert(signupData.data.token !== undefined, 'Email Signup returns JWT token');

    const emailToken = signupData.data.token;

    // Test Duplicate Email Prevention
    const duplicateRes = await fetch(`${baseUrl}/auth/email/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(emailSignupPayload)
    });
    assert(duplicateRes.status === 409, 'Duplicate Email registration blocked with 409 Conflict');

    // Test Email Login
    const loginRes = await fetch(`${baseUrl}/auth/email/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ramesh.farmer@example.com',
        password: 'StrongPassword123!'
      })
    });
    const loginData = await loginRes.json();

    assert(loginRes.status === 200, 'Email Login status code is 200');
    assert(loginData.success === true, 'Email Login response success is true');
    assert(loginData.data.token !== undefined, 'Email Login returns JWT token');

    // Test Invalid Credentials
    const badLoginRes = await fetch(`${baseUrl}/auth/email/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ramesh.farmer@example.com',
        password: 'WrongPassword'
      })
    });
    assert(badLoginRes.status === 401, 'Invalid password rejected with 401 Unauthorized');

    // ----------------------------------------------------
    // TEST SUITE 2: Mobile OTP Authentication
    // ----------------------------------------------------
    console.log('\n--- 2. Testing Mobile OTP Authentication ---');

    const testPhone = '+919876543210';

    // Step 1: Send OTP
    const sendOtpRes = await fetch(`${baseUrl}/auth/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: testPhone })
    });
    const sendOtpData = await sendOtpRes.json();

    assert(sendOtpRes.status === 200, 'Request Mobile OTP status code is 200');
    assert(sendOtpData.success === true, 'Request Mobile OTP success is true');
    assert(sendOtpData.data.devOtp !== undefined, 'OTP generated in dev response');

    const generatedOtp = sendOtpData.data.devOtp;

    // Step 2: Verify Invalid OTP
    const badOtpRes = await fetch(`${baseUrl}/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: testPhone,
        otp: '000000'
      })
    });
    assert(badOtpRes.status === 400, 'Invalid OTP rejected with 400 Bad Request');

    // Step 3: Verify Valid OTP & Register Phone User (with Name & Age)
    const verifyOtpRes = await fetch(`${baseUrl}/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: testPhone,
        otp: generatedOtp,
        name: 'Suresh Patel',
        age: 38
      })
    });
    const verifyOtpData = await verifyOtpRes.json();

    assert(verifyOtpRes.status === 200, 'Verify Mobile OTP status code is 200');
    assert(verifyOtpData.success === true, 'Verify Mobile OTP success is true');
    assert(verifyOtpData.data.user.name === 'Suresh Patel', 'Mobile Signup saves Name');
    assert(verifyOtpData.data.user.age === 38, 'Mobile Signup saves Age');
    assert(verifyOtpData.data.user.phone === testPhone, 'Mobile Signup saves Phone');
    assert(verifyOtpData.data.token !== undefined, 'Mobile Signup returns JWT token');

    const phoneToken = verifyOtpData.data.token;

    // ----------------------------------------------------
    // TEST SUITE 3: Google Authentication (Android Sign-In)
    // ----------------------------------------------------
    console.log('\n--- 3. Testing Google Authentication ---');

    const googlePayload = {
      idToken: 'mock_google_token_anita.sharma',
      age: 29
    };

    const googleRes = await fetch(`${baseUrl}/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(googlePayload)
    });
    const googleData = await googleRes.json();

    assert(googleRes.status === 200, 'Google Auth status code is 200');
    assert(googleData.success === true, 'Google Auth success is true');
    assert(googleData.data.user.authProvider === 'google', 'Google Auth sets authProvider to google');
    assert(googleData.data.user.age === 29, 'Google Auth saves Age');
    assert(googleData.data.token !== undefined, 'Google Auth returns JWT token');

    // ----------------------------------------------------
    // TEST SUITE 4: Protected User Profile & JWT Middleware
    // ----------------------------------------------------
    console.log('\n--- 4. Testing Profile Management (GET /auth/me & PUT /users/profile) ---');

    // GET /auth/me without token
    const unauthMeRes = await fetch(`${baseUrl}/auth/me`);
    assert(unauthMeRes.status === 401, 'Unauthorized request to /auth/me returns 401');

    // GET /auth/me with valid token
    const authMeRes = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${emailToken}` }
    });
    const authMeData = await authMeRes.json();

    assert(authMeRes.status === 200, 'Authorized request to /auth/me returns 200');
    assert(authMeData.data.user.email === 'ramesh.farmer@example.com', '/auth/me returns correct user data');

    // Update Profile (PUT /users/profile)
    const updateProfileRes = await fetch(`${baseUrl}/users/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${emailToken}`
      },
      body: JSON.stringify({
        age: 43,
        name: 'Ramesh Kumar Patel'
      })
    });
    const updateProfileData = await updateProfileRes.json();

    assert(updateProfileRes.status === 200, 'Update Profile status code is 200');
    assert(updateProfileData.data.user.age === 43, 'Profile age updated to 43');
    assert(updateProfileData.data.user.name === 'Ramesh Kumar Patel', 'Profile name updated');

    // ----------------------------------------------------
    // TEST SUITE 5: IoT Hardware Device Management & Telemetry
    // ----------------------------------------------------
    console.log('\n--- 5. Testing IoT Device Management & Sensor Telemetry ---');

    // Register Device
    const regDeviceRes = await fetch(`${baseUrl}/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${phoneToken}`
      },
      body: JSON.stringify({
        deviceId: 'AAROH-SOIL-001',
        deviceName: 'North Field Node 1',
        deviceType: 'soil_node',
        farmSection: 'Plot A - Rice Paddy',
        thresholds: {
          soilMoistureMin: 30,
          soilMoistureMax: 70,
          soilTempMin: 15,
          soilTempMax: 35
        }
      })
    });
    const regDeviceData = await regDeviceRes.json();

    assert(regDeviceRes.status === 201, 'Device registration status is 201');
    assert(regDeviceData.data.device.deviceId === 'AAROH-SOIL-001', 'Device ID registered correctly');

    // Ingest Telemetry
    const telemetryRes = await fetch(`${baseUrl}/sensor-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${phoneToken}`
      },
      body: JSON.stringify({
        deviceId: 'AAROH-SOIL-001',
        soilMoisture: 45.5,
        soilTemperature: 24.2,
        soilPh: 6.8,
        nitrogen: 140,
        phosphorus: 45,
        potassium: 190,
        ambientTemperature: 28.5,
        ambientHumidity: 65,
        sunlightLux: 45000,
        batteryLevel: 94
      })
    });
    const telemetryData = await telemetryRes.json();

    assert(telemetryRes.status === 201, 'Telemetry recording status is 201');
    assert(telemetryData.data.reading.soilMoisture === 45.5, 'Telemetry recorded soilMoisture');

    // Fetch Latest Telemetry for Dashboard
    const latestRes = await fetch(`${baseUrl}/sensor-data/latest`, {
      headers: { Authorization: `Bearer ${phoneToken}` }
    });
    const latestData = await latestRes.json();

    assert(latestRes.status === 200, 'Latest dashboard readings fetched with status 200');
    assert(latestData.data.data.length === 1, 'Returns latest reading for registered device');
    assert(latestData.data.data[0].telemetry.soilMoisture === 45.5, 'Returns correct latest telemetry data');

    // Summary
    console.log('\n========================================================');
    console.log(`📊 Test Results: ${passedCount} Passed, ${failedCount} Failed`);
    console.log('========================================================\n');

    if (failedCount > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('Fatal Test Error:', error);
    process.exit(1);
  } finally {
    if (server) server.close();
    if (mongoose.connection) await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  }
};

runTests();
