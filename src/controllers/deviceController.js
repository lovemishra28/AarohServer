const Device = require('../models/Device');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

/**
 * @desc    Register a new IoT hardware device for the farmer
 * @route   POST /api/v1/devices
 * @access  Private
 */
const registerDevice = async (req, res, next) => {
  try {
    const { deviceId, deviceName, deviceType, farmSection, location, thresholds } = req.body;

    // Check if device ID is already registered
    const existing = await Device.findOne({ deviceId: deviceId.toUpperCase() });
    if (existing) {
      throw new ApiError(`Device with ID '${deviceId.toUpperCase()}' is already registered.`, 409);
    }

    const device = await Device.create({
      deviceId: deviceId.toUpperCase(),
      deviceName: deviceName || 'Aaroh Field Sensor',
      userId: req.user._id,
      deviceType: deviceType || 'soil_node',
      farmSection: farmSection || 'Main Plot',
      location: location || {},
      thresholds: thresholds || {}
    });

    return ApiResponse.created(res, 'Device registered successfully', {
      device
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get all devices belonging to the logged-in farmer
 * @route   GET /api/v1/devices
 * @access  Private
 */
const getMyDevices = async (req, res, next) => {
  try {
    const devices = await Device.find({ userId: req.user._id }).sort({ createdAt: -1 });

    return ApiResponse.success(res, 'Devices fetched successfully', {
      count: devices.length,
      devices
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get details of a single device
 * @route   GET /api/v1/devices/:id
 * @access  Private
 */
const getDeviceById = async (req, res, next) => {
  try {
    const device = await Device.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!device) {
      throw new ApiError('Device not found or not authorized to access', 404);
    }

    return ApiResponse.success(res, 'Device details fetched', {
      device
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update device settings / thresholds
 * @route   PUT /api/v1/devices/:id
 * @access  Private
 */
const updateDevice = async (req, res, next) => {
  try {
    const { deviceName, farmSection, thresholds, status, location } = req.body;

    const device = await Device.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!device) {
      throw new ApiError('Device not found or not authorized to access', 404);
    }

    if (deviceName) device.deviceName = deviceName;
    if (farmSection) device.farmSection = farmSection;
    if (status) device.status = status;
    if (location) device.location = { ...device.location, ...location };
    if (thresholds) {
      device.thresholds = {
        ...device.thresholds,
        ...thresholds
      };
    }

    await device.save();

    return ApiResponse.success(res, 'Device updated successfully', {
      device
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete / Unlink a device
 * @route   DELETE /api/v1/devices/:id
 * @access  Private
 */
const deleteDevice = async (req, res, next) => {
  try {
    const device = await Device.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!device) {
      throw new ApiError('Device not found or not authorized to delete', 404);
    }

    return ApiResponse.success(res, 'Device unlinked successfully');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  registerDevice,
  getMyDevices,
  getDeviceById,
  updateDevice,
  deleteDevice
};
