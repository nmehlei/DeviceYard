#!/usr/bin/env node
const { spawnSync } = require("child_process");
const { resolveBinary } = require("./resolve");

let target;
try {
  target = resolveBinary(process.platform, process.arch, (id) => require.resolve(id));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// stdio inherit: `deviceyard login` reads a token from the real stdin, and the
// progress stream has to reach the real stdout unbuffered.
const result = spawnSync(target.binary, process.argv.slice(2), { stdio: "inherit" });

// status is null when the child was killed by a signal - treat that as a CLI
// failure (1) rather than as success, which `exit(null)` would produce.
process.exit(result.status === null ? 1 : result.status);
