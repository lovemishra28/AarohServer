const User = require('../models/User');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

/**
 * @desc    Update Current User Profile (Name, Age, Farm Details, Avatar)
 * @route   PUT /api/v1/users/profile
 * @access  Private
 */
const updateProfile = async (req, res, next) => {
  try {
    const { name, age, avatar, farmDetails } = req.body;
    const user = req.user;

    if (name) user.name = name;
    if (age !== undefined) user.age = Number(age);
    if (avatar) user.avatar = avatar;
    if (farmDetails) {
      user.farmDetails = {
        ...user.farmDetails.toObject(),
        ...farmDetails
      };
    }

    await user.save();

    return ApiResponse.success(res, 'Profile updated successfully', {
      user
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Change User Password
 * @route   PUT /api/v1/users/change-password
 * @access  Private
 */
const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select('+password');

    if (user.authProvider !== 'email') {
      throw new ApiError(`Password cannot be changed for accounts registered with ${user.authProvider}`, 400);
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      throw new ApiError('Current password is incorrect', 400);
    }

    user.password = newPassword;
    await user.save();

    return ApiResponse.success(res, 'Password changed successfully');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  updateProfile,
  changePassword
};
