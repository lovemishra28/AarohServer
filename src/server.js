const app = require('./app');
const connectDB = require('./config/db');
const env = require('./config/env');

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error(`[Uncaught Exception] ${err.name}: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

const startServer = async () => {
  // Connect to Database
  await connectDB();

  const server = app.listen(env.PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Aaroh Agriculture Server running on port ${env.PORT}`);
    console.log(`🌐 Environment: ${env.NODE_ENV}`);
    console.log(`📱 Local Access: http://localhost:${env.PORT}`);
    console.log(`🤖 Android Emulator Access: http://10.0.2.2:${env.PORT}`);
    console.log(`📡 Health Check: http://localhost:${env.PORT}/health`);
    console.log(`🔑 Auth Endpoint: http://localhost:${env.PORT}/api/v1/auth`);
    console.log(`======================================================\n`);
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (err) => {
    console.error(`[Unhandled Rejection] ${err.name}: ${err.message}`);
    console.error(err.stack);
    server.close(() => {
      process.exit(1);
    });
  });

  // Handle termination signals
  process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM received. Shutting down gracefully...');
    server.close(() => {
      console.log('[Server] Process terminated.');
    });
  });
};

startServer();
