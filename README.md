# Aaroh Agriculture IoT - Backend Server

> High-performance Node.js & Express REST API backend designed for the Aaroh Android Agriculture Application and IoT field devices.

---

## 🌟 Key Features

1. **3-Way Authentication**:
   - **Email & Password**: Registration and login with `bcrypt` password hashing, capturing Name and Age.
   - **Mobile OTP**: 6-digit phone verification with automated MongoDB TTL expiry (auto-cleanup).
   - **Google Sign-In**: Seamless Android Google ID Token verification using `google-auth-library`.
2. **Farmer Profile Management**:
   - Stores `name`, `age`, contact details, role (`farmer`), and farm details (farm size, crop types, soil type, GPS coordinates).
3. **IoT Agriculture Device Management**:
   - Register hardware sensors (Soil Node, Weather Station, Irrigation Controller).
   - Custom threshold configuration (soil moisture min/max, soil temp, pH).
4. **Sensor Telemetry & Time-Series History**:
   - Real-time ingestion of soil moisture, soil temperature, N-P-K nutrients, pH, sunlight lux, ambient climate, and battery levels.
   - Historical time-series endpoints (`24h`, `7d`, `30d`) optimized for Android charts (MPAndroidChart / Jetpack Compose).

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js**: v18 or higher (Recommended v20+)
- **MongoDB**: Local MongoDB instance (`mongodb://127.0.0.1:27017`) or [MongoDB Atlas Cloud Cluster](https://www.mongodb.com/cloud/atlas).

### 2. Installation
```bash
# Clone & install dependencies
npm install
```

### 3. Environment Configuration
Create a `.env` file in the root directory (or copy from `.env.example`):
```env
PORT=5000
NODE_ENV=development
MONGODB_URI=mongodb://127.0.0.1:27017/aaroh_agriculture_db
JWT_SECRET=aaroh_super_secret_jwt_key_agriculture_2026_change_in_production
JWT_EXPIRE=30d
GOOGLE_CLIENT_ID=your_android_client_id.apps.googleusercontent.com
OTP_TTL_MINUTES=5
OTP_LENGTH=6
DEFAULT_DEV_OTP=123456
SMS_PROVIDER=mock
```

### 4. Running the Server
```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm start

# Run Automated Test Suite
npm run test:auth
```

---

## 🤖 Android Integration Guide

### Base URLs for Android
- **Android Emulator**: `http://10.0.2.2:5000/api/v1`
- **Physical Device**: `http://<YOUR_COMPUTER_LOCAL_IP>:5000/api/v1` *(e.g. `http://192.168.1.100:5000/api/v1`)*

---

## 📡 API Reference

### 1. Authentication Endpoints (`/api/v1/auth`)

#### A. Email Sign Up
- **Method**: `POST`
- **Endpoint**: `/api/v1/auth/email/signup`
- **Request Body**:
```json
{
  "name": "Ramesh Kumar",
  "age": 42,
  "email": "ramesh@example.com",
  "password": "StrongPassword123!",
  "role": "farmer",
  "farmDetails": {
    "farmName": "Green Valley Farm",
    "totalAreaAcres": 10,
    "cropTypes": ["Wheat", "Mustard"],
    "soilType": "Alluvial"
  }
}
```
- **Response** (`201 Created`):
```json
{
  "success": true,
  "message": "User registered successfully via Email",
  "data": {
    "user": {
      "_id": "67b36f...",
      "name": "Ramesh Kumar",
      "age": 42,
      "email": "ramesh@example.com",
      "authProvider": "email",
      "role": "farmer",
      "farmDetails": { ... }
    },
    "token": "eyJhbGciOiJIUzI1NiIsIn..."
  }
}
```

---

#### B. Email Login
- **Method**: `POST`
- **Endpoint**: `/api/v1/auth/email/login`
- **Request Body**:
```json
{
  "email": "ramesh@example.com",
  "password": "StrongPassword123!"
}
```
- **Response** (`200 OK`):
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": { ... },
    "token": "eyJhbGciOiJIUzI1NiIsIn..."
  }
}
```

---

#### C. Request Mobile OTP
- **Method**: `POST`
- **Endpoint**: `/api/v1/auth/otp/send`
- **Request Body**:
```json
{
  "phone": "+919876543210"
}
```
- **Response** (`200 OK`):
```json
{
  "success": true,
  "message": "Verification OTP sent successfully to +919876543210",
  "data": {
    "phone": "+919876543210",
    "expiresInMinutes": 5,
    "devOtp": "123456"
  }
}
```

---

#### D. Verify Mobile OTP & Sign Up / Login
- **Method**: `POST`
- **Endpoint**: `/api/v1/auth/otp/verify`
- **Request Body**:
```json
{
  "phone": "+919876543210",
  "otp": "123456",
  "name": "Suresh Patel",
  "age": 38
}
```
- **Response** (`200 OK`):
```json
{
  "success": true,
  "message": "Mobile login successful",
  "data": {
    "user": {
      "_id": "67b370...",
      "name": "Suresh Patel",
      "age": 38,
      "phone": "+919876543210",
      "authProvider": "phone",
      "role": "farmer",
      "isVerified": true
    },
    "isNewUser": true,
    "token": "eyJhbGciOiJIUzI1NiIsIn..."
  }
}
```

---

#### E. Continue with Google (Android Google Sign-In)
- **Method**: `POST`
- **Endpoint**: `/api/v1/auth/google`
- **Request Body**:
```json
{
  "idToken": "eyJhbGciOiJSUzI1NiIsImtpZ...",
  "age": 35
}
```
- **Response** (`200 OK`):
```json
{
  "success": true,
  "message": "Google login successful",
  "data": {
    "user": {
      "_id": "67b371...",
      "name": "Anita Sharma",
      "age": 35,
      "email": "anita.sharma@gmail.com",
      "authProvider": "google",
      "avatar": "https://lh3.googleusercontent.com/...",
      "role": "farmer"
    },
    "isNewUser": false,
    "token": "eyJhbGciOiJIUzI1NiIsIn..."
  }
}
```

---

#### F. Get Current User Profile
- **Method**: `GET`
- **Endpoint**: `/api/v1/auth/me`
- **Headers**:
  - `Authorization: Bearer <your_jwt_token>`
- **Response** (`200 OK`):
```json
{
  "success": true,
  "message": "User profile retrieved",
  "data": {
    "user": {
      "_id": "67b371...",
      "name": "Anita Sharma",
      "age": 35,
      "email": "anita.sharma@gmail.com",
      "phone": null,
      "role": "farmer"
    }
  }
}
```

---

### 2. User Profile Management (`/api/v1/users`)

- **`PUT /api/v1/users/profile`**: Update Name, Age, Avatar, and Farm Details.
- **`PUT /api/v1/users/change-password`**: Update email password.

---

### 3. Device Management (`/api/v1/devices`)

- **`POST /api/v1/devices`**: Register hardware IoT device (`deviceId`, `deviceName`, `thresholds`).
- **`GET /api/v1/devices`**: Fetch list of all registered devices for the current user.
- **`GET /api/v1/devices/:id`**: View device details & alert thresholds.
- **`PUT /api/v1/devices/:id`**: Update device settings.
- **`DELETE /api/v1/devices/:id`**: Unlink a device.

---

### 4. Agriculture IoT Telemetry (`/api/v1/sensor-data`)

- **`POST /api/v1/sensor-data`**: Ingest sensor reading from hardware node or test client.
- **`GET /api/v1/sensor-data/latest`**: Fetch latest telemetry for all farmer devices (Dashboard view).
- **`GET /api/v1/sensor-data/history/:deviceId?range=24h`**: Fetch historical time-series data (`24h`, `7d`, `30d`) for charts.

---

## 📱 Kotlin (Android) Integration Snippet

### Retrofit Service Definition (`AarohApiService.kt`)
```kotlin
package com.aaroh.app.network

import retrofit2.Response
import retrofit2.http.*

interface AarohApiService {

    // --- Authentication ---
    @POST("auth/email/signup")
    suspend fun signupEmail(@Body request: EmailSignupRequest): Response<AuthResponse>

    @POST("auth/email/login")
    suspend fun loginEmail(@Body request: EmailLoginRequest): Response<AuthResponse>

    @POST("auth/otp/send")
    suspend fun sendOtp(@Body request: SendOtpRequest): Response<ApiResponse<OtpData>>

    @POST("auth/otp/verify")
    suspend fun verifyOtp(@Body request: VerifyOtpRequest): Response<AuthResponse>

    @POST("auth/google")
    suspend fun authWithGoogle(@Body request: GoogleAuthRequest): Response<AuthResponse>

    @GET("auth/me")
    suspend fun getProfile(@Header("Authorization") token: String): Response<ApiResponse<UserData>>

    // --- IoT Dashboard ---
    @GET("sensor-data/latest")
    suspend fun getLatestSensorData(@Header("Authorization") token: String): Response<ApiResponse<List<DeviceTelemetryItem>>>

    @GET("sensor-data/history/{deviceId}")
    suspend fun getSensorHistory(
        @Header("Authorization") token: String,
        @Path("deviceId") deviceId: String,
        @Query("range") range: String = "24h"
    ): Response<ApiResponse<HistoryData>>
}
```

---

## 🏗️ Project Architecture

```
AarohServer/
├── src/
│   ├── config/
│   │   ├── db.js                   # MongoDB connection & reconnect logic
│   │   └── env.js                  # Environment variables & defaults
│   ├── controllers/
│   │   ├── authController.js       # Email, Phone OTP, Google Auth, Profile
│   │   ├── userController.js       # Profile & password updates
│   │   ├── deviceController.js     # IoT device registration & configuration
│   │   └── sensorDataController.js # Sensor telemetry ingestion & charts
│   ├── middlewares/
│   │   ├── authMiddleware.js       # JWT extraction & RBAC
│   │   ├── validateMiddleware.js   # Request validation handler
│   │   └── errorMiddleware.js      # Global error and 404 handler
│   ├── models/
│   │   ├── User.js                 # User schema (Name, Age, Email, Phone, GoogleId)
│   │   ├── Otp.js                  # OTP schema with TTL auto-deletion
│   │   ├── Device.js               # IoT Device schema & thresholds
│   │   └── SensorReading.js        # Telemetry data schema & time-series indexes
│   ├── routes/
│   │   ├── authRoutes.js           # Auth routes (/api/v1/auth)
│   │   ├── userRoutes.js           # User routes (/api/v1/users)
│   │   ├── deviceRoutes.js         # Device routes (/api/v1/devices)
│   │   ├── sensorDataRoutes.js     # Sensor data routes (/api/v1/sensor-data)
│   │   └── index.js                # Master route aggregator
│   ├── services/
│   │   ├── otpService.js           # OTP generation & SMS dispatch
│   │   ├── googleAuthService.js    # Google OAuth2 token verification
│   │   └── tokenService.js         # JWT signing & verification
│   ├── utils/
│   │   ├── apiError.js             # Custom ApiError class
│   │   └── apiResponse.js          # Standardized Android response wrapper
│   ├── app.js                      # Express app, helmet, cors, compression
│   └── server.js                   # Server entry point & graceful shutdown
├── tests/
│   └── test-auth.js                # Full integration test suite
├── .env.example                    # Environment variable template
├── package.json
└── README.md
```
