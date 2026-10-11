// Config parser errors can contain user-supplied JSON. Do not log them here.
try {
  require('../dist/src/config.js').loadConfig(process.env);
} catch {
  console.error('Invalid DeviceYard configuration. Check the required environment variables in the container guide.');
  process.exitCode = 1;
}
