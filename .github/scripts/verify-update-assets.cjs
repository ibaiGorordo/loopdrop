#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { lstat, readFile } = require("node:fs/promises");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const yaml = require("js-yaml");

function targetDefinition(kind, version) {
  const prefix = `loopdrop-${version}`;
  const definitions = {
    "mac-arm64": {
      manifest: "latest-mac.yml",
      payloads: [`${prefix}-mac-arm64.zip`, `${prefix}-mac-arm64.dmg`],
      primary: `${prefix}-mac-arm64.zip`,
      blockmaps: [`${prefix}-mac-arm64.zip.blockmap`, `${prefix}-mac-arm64.dmg.blockmap`],
      requirePublisher: false,
    },
    "mac-x64": {
      manifest: "latest-mac.yml",
      payloads: [`${prefix}-mac-x64.zip`, `${prefix}-mac-x64.dmg`],
      primary: `${prefix}-mac-x64.zip`,
      blockmaps: [`${prefix}-mac-x64.zip.blockmap`, `${prefix}-mac-x64.dmg.blockmap`],
      requirePublisher: false,
    },
    "mac-universal": {
      manifest: "latest-mac.yml",
      payloads: [`${prefix}-mac-universal.zip`, `${prefix}-mac-universal.dmg`],
      primary: `${prefix}-mac-universal.zip`,
      blockmaps: [`${prefix}-mac-universal.zip.blockmap`, `${prefix}-mac-universal.dmg.blockmap`],
      requirePublisher: false,
    },
    "win-x64": {
      manifest: "latest.yml",
      payloads: [`${prefix}-win-x64.exe`],
      primary: `${prefix}-win-x64.exe`,
      blockmaps: [`${prefix}-win-x64.exe.blockmap`],
      requirePublisher: true,
    },
    "linux-x64": {
      manifest: "latest-linux.yml",
      payloads: [`${prefix}-linux-x86_64.AppImage`, `${prefix}-linux-amd64.deb`],
      primary: `${prefix}-linux-x86_64.AppImage`,
      allowedPrimaries: [`${prefix}-linux-x86_64.AppImage`, `${prefix}-linux-amd64.deb`],
      blockmaps: [],
      requirePublisher: false,
    },
    "linux-arm64": {
      manifest: "latest-linux-arm64.yml",
      payloads: [`${prefix}-linux-arm64.AppImage`, `${prefix}-linux-arm64.deb`],
      primary: `${prefix}-linux-arm64.AppImage`,
      allowedPrimaries: [`${prefix}-linux-arm64.AppImage`, `${prefix}-linux-arm64.deb`],
      blockmaps: [],
      requirePublisher: false,
    },
  };
  const definition = definitions[kind];
  if (!definition) throw new Error(`Unsupported updater target: ${kind}`);
  return definition;
}

async function regularFile(filePath, { nonempty = true } = {}) {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Expected a regular file: ${filePath}`);
  if (nonempty && stats.size < 1) throw new Error(`Expected a non-empty file: ${filePath}`);
  return stats;
}

async function sha512(filePath) {
  const hash = createHash("sha512");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("base64");
}

async function readYaml(filePath) {
  await regularFile(filePath);
  const parsed = yaml.load(await readFile(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a YAML object: ${filePath}`);
  }
  return parsed;
}

async function verifyBlockmap(blockmapPath, payloadSize) {
  await regularFile(blockmapPath);
  let blockmap;
  try {
    blockmap = JSON.parse(gunzipSync(await readFile(blockmapPath)).toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid compressed blockmap ${blockmapPath}: ${error instanceof Error ? error.message : error}`);
  }
  if (blockmap?.version !== "2" || !Array.isArray(blockmap.files) || blockmap.files.length !== 1) {
    throw new Error(`Unexpected blockmap structure: ${blockmapPath}`);
  }
  const [entry] = blockmap.files;
  if (
    entry?.name !== "file" || entry.offset !== 0 || !Array.isArray(entry.sizes) ||
    !Array.isArray(entry.checksums) || entry.sizes.length === 0 ||
    entry.sizes.length !== entry.checksums.length ||
    entry.sizes.some((size) => !Number.isSafeInteger(size) || size < 1) ||
    entry.checksums.some((checksum) => typeof checksum !== "string" || checksum.length < 1) ||
    entry.sizes.reduce((sum, size) => sum + size, 0) !== payloadSize
  ) {
    throw new Error(`Blockmap does not describe its payload exactly: ${blockmapPath}`);
  }
}

function assertExactNames(actual, expected, label) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    throw new Error(`${label} mismatch: expected ${sortedExpected.join(", ")}; got ${sortedActual.join(", ")}`);
  }
}

function normalizedPublishers(value) {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value];
  return entries.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim());
}

async function verifyAppUpdateConfig(appUpdatePath, { requirePublisher }) {
  const config = await readYaml(appUpdatePath);
  if (config.provider !== "github" || config.owner !== "ibaiGorordo" || config.repo !== "loopdrop") {
    throw new Error("Packaged app-update.yml does not point to the canonical public GitHub repository.");
  }
  if (
    (config.host !== undefined && config.host !== "github.com") ||
    (config.protocol !== undefined && config.protocol !== "https")
  ) {
    throw new Error("Packaged updates must use the canonical HTTPS GitHub endpoint.");
  }
  if (config.private !== undefined && config.private !== false) {
    throw new Error("Packaged updates must use the public GitHub release provider.");
  }
  if (config.token !== undefined && config.token !== null) {
    throw new Error("Packaged updater configuration must not contain a GitHub token.");
  }
  if (config.releaseType !== "release") throw new Error("Packaged updates must use stable GitHub releases.");
  if (config.channel !== undefined && config.channel !== "latest") {
    throw new Error("Packaged updates must use the stable latest channel.");
  }
  if (config.updaterCacheDirName !== "loopdrop-updater") throw new Error("Unexpected updater cache directory name.");
  const publishers = normalizedPublishers(config.publisherName);
  if (requirePublisher && publishers.length === 0) {
    throw new Error("The signed Windows app-update.yml must contain at least one publisherName.");
  }
  if (publishers.some((publisher) => /^(?:CN|O|OU|C|L|ST|E|EMAILADDRESS)\s*=/i.test(publisher))) {
    throw new Error("publisherName must contain a certificate common name, not a distinguished name.");
  }
  return publishers;
}

async function verifyUpdateAssets({ kind, version, directory, appUpdatePath }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid stable version: ${version}`);
  const definition = targetDefinition(kind, version);
  const baseDirectory = path.resolve(directory);
  const manifestPath = path.join(baseDirectory, definition.manifest);
  const manifest = await readYaml(manifestPath);
  if (manifest.version !== version) {
    throw new Error(`${definition.manifest} version ${manifest.version} does not match ${version}.`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${definition.manifest} has no update payloads.`);
  }

  const urls = manifest.files.map((entry) => entry?.url);
  if (urls.some((url) => typeof url !== "string" || url !== path.basename(url))) {
    throw new Error(`${definition.manifest} contains an unsafe or non-local artifact name.`);
  }
  if (new Set(urls).size !== urls.length) throw new Error(`${definition.manifest} contains duplicate payloads.`);
  assertExactNames(urls, definition.payloads, `${definition.manifest} payloads`);

  const hashes = new Map();
  const sizes = new Map();
  for (const entry of manifest.files) {
    const artifactPath = path.join(baseDirectory, entry.url);
    const stats = await regularFile(artifactPath);
    if (!Number.isSafeInteger(entry.size) || entry.size !== stats.size) {
      throw new Error(`${entry.url} size does not match ${definition.manifest}.`);
    }
    const digest = await sha512(artifactPath);
    if (entry.sha512 !== digest) throw new Error(`${entry.url} SHA-512 does not match ${definition.manifest}.`);
    hashes.set(entry.url, digest);
    sizes.set(entry.url, stats.size);
  }

  const allowedPrimaries = definition.allowedPrimaries || [definition.primary];
  if (!allowedPrimaries.includes(manifest.path)) {
    throw new Error(`${definition.manifest} selects an unexpected primary updater payload: ${manifest.path}.`);
  }
  if (manifest.sha512 !== hashes.get(manifest.path)) {
    throw new Error(`${definition.manifest} primary SHA-512 does not match ${manifest.path}.`);
  }
  if (typeof manifest.releaseDate !== "string" || !Number.isFinite(Date.parse(manifest.releaseDate))) {
    throw new Error(`${definition.manifest} has an invalid releaseDate.`);
  }

  for (const blockmap of definition.blockmaps) {
    const payload = blockmap.slice(0, -".blockmap".length);
    await verifyBlockmap(path.join(baseDirectory, blockmap), sizes.get(payload));
  }
  const publishers = appUpdatePath
    ? await verifyAppUpdateConfig(path.resolve(appUpdatePath), definition)
    : [];
  return {
    kind,
    version,
    manifest: definition.manifest,
    primary: manifest.path,
    payloads: definition.payloads,
    publishers,
  };
}

async function main() {
  const [kind, version, directory, appUpdatePath] = process.argv.slice(2);
  if (!kind || !version || !directory || !appUpdatePath) {
    throw new Error("Usage: verify-update-assets.cjs TARGET VERSION RELEASE_DIRECTORY APP_UPDATE_YML");
  }
  const result = await verifyUpdateAssets({ kind, version, directory, appUpdatePath });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  normalizedPublishers,
  sha512,
  targetDefinition,
  verifyAppUpdateConfig,
  verifyUpdateAssets,
};
