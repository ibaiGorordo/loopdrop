"use strict";

const { createHash } = require("node:crypto");
const {
  lstatSync,
  readFileSync,
  readdirSync,
} = require("node:fs");
const path = require("node:path");

function fail(message) {
  throw new Error(`Packaged license verification failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function configuredVersion(manifest, packageName) {
  const version = manifest.dependencies?.[packageName] ?? manifest.devDependencies?.[packageName];
  assert(
    typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
    `${packageName} is not pinned to an exact version`,
  );
  return version;
}

const [licenseDirectory, expectedPlatform, expectedArchitectureList] = process.argv.slice(2);
assert(licenseDirectory, "a license directory argument is required");
assert(/^(darwin|linux|win32)$/.test(expectedPlatform ?? ""), "the expected platform is invalid");

const expectedArchitectures = (expectedArchitectureList ?? "")
  .split(",")
  .filter(Boolean)
  .sort();
assert(expectedArchitectures.length > 0, "at least one expected architecture is required");
assert(
  new Set(expectedArchitectures).size === expectedArchitectures.length &&
    expectedArchitectures.every((arch) => /^(arm64|x64)$/.test(arch)),
  "the expected architecture list is invalid",
);

const projectManifest = JSON.parse(readFileSync("package.json", "utf8"));
const expectedFiles = new Set(["LICENSE-MANIFEST.json"]);

function readRegularFile(fileName) {
  assert(
    typeof fileName === "string" &&
      fileName.length > 0 &&
      fileName !== "." &&
      fileName !== ".." &&
      path.basename(fileName) === fileName,
    `unsafe license filename: ${String(fileName)}`,
  );
  const filePath = path.join(licenseDirectory, fileName);
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    fail(`missing license file: ${fileName}`);
  }
  assert(stat.isFile() && !stat.isSymbolicLink(), `license entry is not a regular file: ${fileName}`);
  const contents = readFileSync(filePath);
  assert(contents.length > 0, `license file is empty: ${fileName}`);
  expectedFiles.add(fileName);
  return contents;
}

function verifyDigest(fileName, expectedDigest, label) {
  assert(/^[a-f0-9]{64}$/.test(expectedDigest ?? ""), `${label} has an invalid SHA-256 digest`);
  const actualDigest = sha256(readRegularFile(fileName));
  assert(actualDigest === expectedDigest, `${label} SHA-256 mismatch`);
}

const manifest = JSON.parse(readRegularFile("LICENSE-MANIFEST.json").toString("utf8"));
assert(manifest.schemaVersion === 1, "unsupported manifest schema");
assert(manifest.application?.name === projectManifest.name, "application name mismatch");
assert(manifest.application?.version === projectManifest.version, "application version mismatch");
assert(manifest.application?.license === "MIT" && projectManifest.license === "MIT", "application license mismatch");
assert(manifest.application.licenseFile === "Loopdrop-LICENSE.txt", "unexpected application license filename");
assert(manifest.application.thirdPartyNoticesFile === "THIRD_PARTY_NOTICES.md", "unexpected notice filename");
verifyDigest(
  manifest.application.licenseFile,
  manifest.application.licenseSha256,
  "application license",
);
verifyDigest(
  manifest.application.thirdPartyNoticesFile,
  manifest.application.thirdPartyNoticesSha256,
  "third-party notices",
);

const electron = manifest.components?.electron;
assert(electron?.version === configuredVersion(projectManifest, "electron"), "Electron version mismatch");
assert(electron.licenseFile === "Electron-LICENSE.txt", "unexpected Electron license filename");
assert(electron.versionFile === "Electron-version.txt", "unexpected Electron version filename");
verifyDigest(electron.licenseFile, electron.licenseSha256, "Electron license");
assert(
  readRegularFile(electron.versionFile).toString("utf8").trim() === electron.version,
  "Electron version file mismatch",
);
assert(Array.isArray(electron.artifacts), "Electron artifact metadata is missing");
const actualArchitectures = electron.artifacts.map((artifact) => artifact.arch).sort();
assert(
  JSON.stringify(actualArchitectures) === JSON.stringify(expectedArchitectures),
  `Electron architectures mismatch: ${actualArchitectures.join(",")}`,
);
for (const artifact of electron.artifacts) {
  assert(artifact.platform === expectedPlatform, `unexpected Electron platform: ${artifact.platform}`);
  assert(
    artifact.fileName === `electron-v${electron.version}-${expectedPlatform}-${artifact.arch}.zip`,
    `unexpected Electron artifact filename: ${artifact.fileName}`,
  );
  assert(/^[a-f0-9]{64}$/.test(artifact.sha256 ?? ""), "invalid Electron artifact SHA-256");
  verifyDigest(
    artifact.chromiumNoticesFile,
    artifact.chromiumNoticesSha256,
    `Chromium notices for ${artifact.arch}`,
  );
}

for (const [componentName, expectedFile] of [
  ["react", "React-LICENSE.txt"],
  ["reactDom", "React-DOM-LICENSE.txt"],
]) {
  const component = manifest.components?.[componentName];
  const packageName = componentName === "reactDom" ? "react-dom" : "react";
  assert(component?.version === configuredVersion(projectManifest, packageName), `${packageName} version mismatch`);
  assert(component.licenseFile === expectedFile, `unexpected ${packageName} license filename`);
  verifyDigest(component.licenseFile, component.licenseSha256, `${packageName} license`);
}

const actualEntries = readdirSync(licenseDirectory, { withFileTypes: true });
assert(actualEntries.every((entry) => entry.isFile()), "the license directory contains a non-file entry");
const actualFiles = actualEntries.map((entry) => entry.name).sort();
const expectedFileList = [...expectedFiles].sort();
assert(
  JSON.stringify(actualFiles) === JSON.stringify(expectedFileList),
  `license file set mismatch: ${actualFiles.join(", ")}`,
);

console.log(
  `Verified ${actualFiles.length} packaged license files for ${expectedPlatform}/${expectedArchitectures.join("+")}`,
);
