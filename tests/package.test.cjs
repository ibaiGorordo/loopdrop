const assert = require("node:assert/strict");
const test = require("node:test");

const loopdrop = require("..");
const manifest = require("../package.json");

test("the npm entry point exposes the shared engine without becoming the Electron entry point", () => {
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.main, "core/index.cjs");
  assert.equal(manifest.exports["."], "./core/index.cjs");
  assert.equal(manifest.build.extraMetadata.main, "electron/main.cjs");
  assert.equal(manifest.files.some((pattern) => pattern.startsWith("electron")), false);

  assert.equal(typeof loopdrop.convertToGif, "function");
  assert.equal(typeof loopdrop.probeVideo, "function");
  assert.equal(typeof loopdrop.resolveBinary, "function");
  assert.equal(loopdrop.MAX_FRAMES, 300);
});
