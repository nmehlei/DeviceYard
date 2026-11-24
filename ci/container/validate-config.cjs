// Config parser errors can contain user-supplied JSON. Do not log them here.
const fs = require('node:fs');
const path = require('node:path');
// Pro assembles the core under dist/core/ (its own dist/src holds Pro modules); Community ships it under dist/.
const dist = path.join(__dirname, '..', 'dist');
const configModule = ['core/src/config.js', 'src/config.js'].map((file) => path.join(dist, file)).find((file) => fs.existsSync(file));
const incomplete = () => {
  console.error('This image has no usable DeviceYard config module (dist/core/src or dist/src); the image is incomplete.');
  process.exitCode = 1;
};
let loadConfig;
if (configModule) {
  try { ({loadConfig} = require(configModule)); } catch { /* reported below */ }
}
if (typeof loadConfig !== 'function') incomplete();
else {
  try {
    loadConfig(process.env);
  } catch {
    console.error('Invalid DeviceYard configuration. Check the required environment variables in the container guide.');
    process.exitCode = 1;
  }
}
