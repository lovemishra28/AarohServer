const SensorReading = require('../models/SensorReading');
const Device = require('../models/Device');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

/**
 * @desc    Ingest telemetry data from IoT device or mobile simulation
 * @route   POST /api/v1/sensor-data
 * @access  Private / Device Auth
 */
const recordTelemetry = async (req, res, next) => {
  try {
    const {
      deviceId,
      soilMoisture,
      soilTemperature,
      soilPh,
      nitrogen,
      phosphorus,
      potassium,
      electricalConductivity,
      ambientTemperature,
      ambientHumidity,
      sunlightLux,
      rainfallMm,
      batteryLevel,
      recordedAt
    } = req.body;

    // Validate device exists
    const device = await Device.findOne({ deviceId: deviceId.toUpperCase() });
    if (!device) {
      throw new ApiError(`Device with ID '${deviceId}' is not registered.`, 404);
    }

    // Create telemetry record
    const reading = await SensorReading.create({
      deviceId: device.deviceId,
      userId: device.userId,
      soilMoisture,
      soilTemperature,
      soilPh,
      nitrogen,
      phosphorus,
      potassium,
      electricalConductivity,
      ambientTemperature,
      ambientHumidity,
      sunlightLux,
      rainfallMm: rainfallMm || 0,
      batteryLevel: batteryLevel !== undefined ? batteryLevel : device.batteryPercentage,
      recordedAt: recordedAt ? new Date(recordedAt) : new Date()
    });

    // Update device status and heartbeat
    device.status = 'online';
    device.lastPingAt = new Date();
    if (batteryLevel !== undefined) {
      device.batteryPercentage = batteryLevel;
    }
    await device.save();

    return ApiResponse.created(res, 'Telemetry data recorded successfully', {
      reading
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get latest sensor telemetry for all devices of the logged-in farmer (Dashboard)
 * @route   GET /api/v1/sensor-data/latest
 * @access  Private
 */
const getLatestReadings = async (req, res, next) => {
  try {
    const userDevices = await Device.find({ userId: req.user._id });
    const deviceIds = userDevices.map(d => d.deviceId);

    // Find latest reading for each device
    const latestReadings = await Promise.all(
      deviceIds.map(async (dId) => {
        const reading = await SensorReading.findOne({ deviceId: dId }).sort({ recordedAt: -1 });
        const device = userDevices.find(d => d.deviceId === dId);
        return {
          device: {
            id: device._id,
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            farmSection: device.farmSection,
            status: device.status,
            batteryPercentage: device.batteryPercentage,
            thresholds: device.thresholds,
            lastPingAt: device.lastPingAt
          },
          telemetry: reading || null
        };
      })
    );

    return ApiResponse.success(res, 'Latest agricultural data fetched', {
      devicesCount: userDevices.length,
      data: latestReadings
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get historical time-series data for a device (Android Charts)
 * @route   GET /api/v1/sensor-data/history/:deviceId
 * @access  Private
 */
const getDeviceHistory = async (req, res, next) => {
  try {
    const { deviceId } = req.params;
    const { range = '24h', limit = 100 } = req.query;

    const device = await Device.findOne({
      deviceId: deviceId.toUpperCase(),
      userId: req.user._id
    });

    if (!device) {
      throw new ApiError('Device not found or not owned by user', 404);
    }

    // Determine time filter
    let startTime = new Date();
    if (range === '24h') {
      startTime.setHours(startTime.getHours() - 24);
    } else if (range === '7d') {
      startTime.setDate(startTime.getDate() - 7);
    } else if (range === '30d') {
      startTime.setDate(startTime.getDate() - 30);
    } else {
      startTime.setHours(startTime.getHours() - 24);
    }

    const readings = await SensorReading.find({
      deviceId: device.deviceId,
      recordedAt: { $gte: startTime }
    })
      .sort({ recordedAt: 1 })
      .limit(parseInt(limit, 10));

    return ApiResponse.success(res, `Historical data for ${range}`, {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      range,
      count: readings.length,
      readings
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  recordTelemetry,
  getLatestReadings,
  getDeviceHistory
};
