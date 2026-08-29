const { existsSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

function executableName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function resolveBinary(name, options = {}) {
  const envName = name === "ffprobe" ? "LOOPDROP_FFPROBE_PATH" : "LOOPDROP_FFMPEG_PATH";
  if (process.env[envName]) return process.env[envName];
  const executable = executableName(name);
  const candidates = [];
  if (options.resourcesPath) candidates.push(join(options.resourcesPath, "ffmpeg", executable));
  candidates.push(join(__dirname, "..", "vendor", "ffmpeg", "current", executable));

  if (process.platform === "darwin") {
    candidates.push(
      join("/Applications", "Loopdrop.app", "Contents", "Resources", "ffmpeg", executable),
      join(homedir(), "Applications", "Loopdrop.app", "Contents", "Resources", "ffmpeg", executable),
      join("/Applications", "loopdrop.app", "Contents", "Resources", "ffmpeg", executable),
      join(homedir(), "Applications", "loopdrop.app", "Contents", "Resources", "ffmpeg", executable),
    );
  } else if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, "Programs", "Loopdrop", "resources", "ffmpeg", executable));
  } else if (process.platform === "linux") {
    candidates.push(
      join("/opt", "Loopdrop", "resources", "ffmpeg", executable),
      join("/usr", "lib", "loopdrop", "resources", "ffmpeg", executable),
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return executableName(name);
}

module.exports = { executableName, resolveBinary };
