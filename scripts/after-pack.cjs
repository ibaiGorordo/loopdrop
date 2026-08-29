"use strict";

const { createHash } = require("node:crypto");
const { open, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { inflateRawSync } = require("node:zlib");

const ELECTRON_ARCHES = Object.freeze({
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
  4: "universal",
});
const ELECTRON_RELEASE_FILES = Object.freeze([
  "LICENSE",
  "LICENSES.chromium.html",
  "version",
]);
const LICENSE_DIRECTORY = "licenses";
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_NOTICE_BYTES = 128 * 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  const file = await open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    let position = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await file.close();
  }

  return hash.digest("hex");
}

async function readFully(file, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesRead === 0) {
      throw new Error(`Unexpected end of ZIP at byte ${position + offset}`);
    }
    offset += bytesRead;
  }
}

function findEndOfCentralDirectory(tail) {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === tail.length) return offset;
  }
  throw new Error("Electron artifact is not a supported ZIP: EOCD was not found");
}

/**
 * Reads only the named top-level files from a checksum-verified Electron ZIP.
 * Electron release archives are regular, non-ZIP64 archives. Keeping extraction
 * selective avoids expanding hundreds of megabytes of runtime files a second time.
 */
async function readZipEntries(zipPath, requestedNames) {
  const wanted = new Set(requestedNames);
  const result = new Map();
  const file = await open(zipPath, "r");

  try {
    const { size } = await file.stat();
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = Buffer.allocUnsafe(tailLength);
    await readFully(file, tail, size - tailLength);

    const eocdOffset = findEndOfCentralDirectory(tail);
    const diskNumber = tail.readUInt16LE(eocdOffset + 4);
    const centralDirectoryDisk = tail.readUInt16LE(eocdOffset + 6);
    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
    const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);

    if (
      diskNumber !== 0 ||
      centralDirectoryDisk !== 0 ||
      entryCount === 0xffff ||
      centralDirectorySize === 0xffffffff ||
      centralDirectoryOffset === 0xffffffff
    ) {
      throw new Error("Electron artifact uses unsupported multi-disk or ZIP64 metadata");
    }
    if (centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new Error("Electron artifact central directory is unexpectedly large");
    }
    if (centralDirectoryOffset + centralDirectorySize > size) {
      throw new Error("Electron artifact central directory points outside the ZIP");
    }

    const directory = Buffer.allocUnsafe(centralDirectorySize);
    await readFully(file, directory, centralDirectoryOffset);
    const records = new Map();
    let offset = 0;

    for (let index = 0; index < entryCount; index += 1) {
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) {
        throw new Error("Electron artifact has an invalid central-directory entry");
      }

      const flags = directory.readUInt16LE(offset + 8);
      const compression = directory.readUInt16LE(offset + 10);
      const compressedSize = directory.readUInt32LE(offset + 20);
      const uncompressedSize = directory.readUInt32LE(offset + 24);
      const fileNameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const localHeaderOffset = directory.readUInt32LE(offset + 42);
      const recordLength = 46 + fileNameLength + extraLength + commentLength;

      if (offset + recordLength > directory.length) {
        throw new Error("Electron artifact has a truncated central-directory entry");
      }

      const fileName = directory
        .subarray(offset + 46, offset + 46 + fileNameLength)
        .toString("utf8");
      if (wanted.has(fileName)) {
        if ((flags & 0x1) !== 0) {
          throw new Error(`Electron artifact notice is encrypted: ${fileName}`);
        }
        if (compressedSize > MAX_NOTICE_BYTES || uncompressedSize > MAX_NOTICE_BYTES) {
          throw new Error(`Electron artifact notice is unexpectedly large: ${fileName}`);
        }
        records.set(fileName, {
          compression,
          compressedSize,
          uncompressedSize,
          localHeaderOffset,
        });
      }
      offset += recordLength;
    }

    for (const name of wanted) {
      const record = records.get(name);
      if (!record) throw new Error(`Electron artifact is missing required file: ${name}`);

      const localHeader = Buffer.allocUnsafe(30);
      await readFully(file, localHeader, record.localHeaderOffset);
      if (localHeader.readUInt32LE(0) !== 0x04034b50) {
        throw new Error(`Electron artifact has an invalid local header for ${name}`);
      }

      const fileNameLength = localHeader.readUInt16LE(26);
      const extraLength = localHeader.readUInt16LE(28);
      const dataOffset = record.localHeaderOffset + 30 + fileNameLength + extraLength;
      const compressed = Buffer.allocUnsafe(record.compressedSize);
      await readFully(file, compressed, dataOffset);

      let contents;
      if (record.compression === 0) {
        contents = compressed;
      } else if (record.compression === 8) {
        contents = inflateRawSync(compressed);
      } else {
        throw new Error(
          `Electron artifact uses unsupported compression ${record.compression} for ${name}`,
        );
      }

      if (contents.length !== record.uncompressedSize) {
        throw new Error(`Electron artifact notice has the wrong size: ${name}`);
      }
      result.set(name, contents);
    }
  } finally {
    await file.close();
  }

  return result;
}

function configuredExactVersion(manifest, packageName) {
  const configured = manifest.dependencies?.[packageName] ?? manifest.devDependencies?.[packageName];
  if (typeof configured !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(configured)) {
    throw new Error(`${packageName} must be pinned to an exact version for packaged notices`);
  }
  return configured;
}

function resolvePackageDirectory(packageName, projectDir) {
  const entryPath = require.resolve(packageName, { paths: [projectDir] });
  let current = path.dirname(entryPath);

  while (current !== path.dirname(current)) {
    try {
      const packageManifest = require(path.join(current, "package.json"));
      if (packageManifest.name === packageName) return current;
    } catch {
      // Keep walking until the package root is found.
    }
    current = path.dirname(current);
  }

  throw new Error(`Could not locate installed package ${packageName}`);
}

async function readInstalledLicense(projectDir, rootManifest, packageName) {
  const packageDirectory = resolvePackageDirectory(packageName, projectDir);
  const packageManifest = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  const expectedVersion = configuredExactVersion(rootManifest, packageName);
  if (packageManifest.version !== expectedVersion) {
    throw new Error(
      `${packageName} notice version mismatch: configured ${expectedVersion}, installed ${packageManifest.version}`,
    );
  }

  const contents = await readFile(path.join(packageDirectory, "LICENSE"));
  return { version: packageManifest.version, contents, sha256: sha256(contents) };
}

function targetArchitectures(platform, builderArch) {
  const arch = typeof builderArch === "string" ? builderArch : ELECTRON_ARCHES[builderArch];
  if (!arch) throw new Error(`Unsupported electron-builder architecture: ${builderArch}`);
  if (platform === "darwin") {
    if (!["x64", "arm64", "universal"].includes(arch)) {
      throw new Error(`Unsupported Electron ${platform} architecture: ${arch}`);
    }
    // electron-builder creates a universal app by first packaging x64 and arm64,
    // then requiring every non-binary resource to be byte-for-byte identical.
    // Including both exact Darwin notice sets in every Mac package keeps those
    // intermediate apps deterministic and also covers a combined runtime fully.
    return ["x64", "arm64"];
  }
  if (arch === "universal") {
    throw new Error(`Universal Electron artifacts are only supported on macOS, not ${platform}`);
  }
  return [arch];
}

function allBuffersEqual(buffers) {
  return buffers.every((buffer) => buffer.equals(buffers[0]));
}

function safeArtifactSuffix(platform, arch) {
  if (!/^(darwin|linux|win32)$/.test(platform) || !/^[a-z0-9]+$/.test(arch)) {
    throw new Error(`Unsafe Electron artifact target: ${platform}/${arch}`);
  }
  return `${platform}-${arch}`;
}

async function createElectronNotices(projectDir, rootManifest, platform, builderArch) {
  const electronDirectory = resolvePackageDirectory("electron", projectDir);
  const installedManifest = JSON.parse(
    await readFile(path.join(electronDirectory, "package.json"), "utf8"),
  );
  const version = configuredExactVersion(rootManifest, "electron");
  if (installedManifest.version !== version) {
    throw new Error(
      `Electron notice version mismatch: configured ${version}, installed ${installedManifest.version}`,
    );
  }

  const checksums = JSON.parse(
    await readFile(path.join(electronDirectory, "checksums.json"), "utf8"),
  );
  const { downloadArtifact } = await import("@electron/get");
  const artifacts = [];

  for (const arch of targetArchitectures(platform, builderArch)) {
    const fileName = `electron-v${version}-${platform}-${arch}.zip`;
    const expectedArtifactSha256 = checksums[fileName];
    if (!/^[a-f0-9]{64}$/.test(expectedArtifactSha256 ?? "")) {
      throw new Error(`Electron ${version} checksum is missing for ${fileName}`);
    }

    const zipPath = await downloadArtifact({
      version,
      artifactName: "electron",
      platform,
      arch,
      checksums: { [fileName]: expectedArtifactSha256 },
      downloadOptions: { quiet: true },
    });
    const actualArtifactSha256 = await sha256File(zipPath);
    if (actualArtifactSha256 !== expectedArtifactSha256) {
      throw new Error(`Electron artifact checksum mismatch for ${fileName}`);
    }

    const entries = await readZipEntries(zipPath, ELECTRON_RELEASE_FILES);
    const artifactVersion = entries.get("version").toString("utf8").trim();
    if (artifactVersion !== version) {
      throw new Error(
        `Electron artifact ${fileName} reports version ${artifactVersion}, expected ${version}`,
      );
    }

    artifacts.push({
      fileName,
      platform,
      arch,
      sha256: actualArtifactSha256,
      electronLicense: entries.get("LICENSE"),
      chromiumNotices: entries.get("LICENSES.chromium.html"),
      versionFile: entries.get("version"),
    });
  }

  if (!allBuffersEqual(artifacts.map((artifact) => artifact.electronLicense))) {
    throw new Error("Electron MIT license differs between universal runtime artifacts");
  }
  if (!allBuffersEqual(artifacts.map((artifact) => artifact.versionFile))) {
    throw new Error("Electron version differs between universal runtime artifacts");
  }

  return { version, artifacts };
}

async function afterPack(context) {
  const projectDir = context.packager.projectDir;
  const rootManifest = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
  const platform = context.electronPlatformName;
  if (!/^(darwin|linux|win32)$/.test(platform)) {
    throw new Error(`Unsupported Electron packaging platform: ${platform}`);
  }

  const configuredElectronVersion = context.packager.config?.electronVersion;
  const pinnedElectronVersion = configuredExactVersion(rootManifest, "electron");
  if (
    configuredElectronVersion &&
    configuredElectronVersion.replace(/^v/, "") !== pinnedElectronVersion
  ) {
    throw new Error(
      `electron-builder is using ${configuredElectronVersion}, but notices are pinned to ${pinnedElectronVersion}`,
    );
  }

  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  const licenseDir = path.join(resourcesDir, LICENSE_DIRECTORY);
  const relativeLicenseDir = path.relative(context.appOutDir, licenseDir);
  if (relativeLicenseDir.startsWith("..") || path.isAbsolute(relativeLicenseDir)) {
    throw new Error("Refusing to write packaged notices outside appOutDir");
  }

  const projectLicense = await readFile(path.join(projectDir, "LICENSE"));
  const thirdPartyNotices = await readFile(path.join(projectDir, "THIRD_PARTY_NOTICES.md"));
  const react = await readInstalledLicense(projectDir, rootManifest, "react");
  const reactDom = await readInstalledLicense(projectDir, rootManifest, "react-dom");
  const electron = await createElectronNotices(
    projectDir,
    rootManifest,
    platform,
    context.arch,
  );

  await rm(licenseDir, { recursive: true, force: true });
  await mkdir(licenseDir, { recursive: true });

  const fixedFiles = [
    ["Loopdrop-LICENSE.txt", projectLicense],
    ["THIRD_PARTY_NOTICES.md", thirdPartyNotices],
    ["Electron-LICENSE.txt", electron.artifacts[0].electronLicense],
    ["Electron-version.txt", electron.artifacts[0].versionFile],
    ["React-LICENSE.txt", react.contents],
    ["React-DOM-LICENSE.txt", reactDom.contents],
  ];
  for (const [fileName, contents] of fixedFiles) {
    await writeFile(path.join(licenseDir, fileName), contents);
  }

  const chromiumGroups = new Map();
  for (const artifact of electron.artifacts) {
    const digest = sha256(artifact.chromiumNotices);
    if (!chromiumGroups.has(digest)) chromiumGroups.set(digest, []);
    chromiumGroups.get(digest).push(artifact);
  }

  for (const [digest, artifacts] of chromiumGroups) {
    const outputName =
      chromiumGroups.size === 1
        ? "Electron-LICENSES.chromium.html"
        : `Electron-LICENSES.chromium.${safeArtifactSuffix(
            artifacts[0].platform,
            artifacts[0].arch,
          )}.html`;
    await writeFile(path.join(licenseDir, outputName), artifacts[0].chromiumNotices);
    for (const artifact of artifacts) {
      artifact.chromiumOutput = outputName;
      artifact.chromiumSha256 = digest;
    }
  }

  const manifest = {
    schemaVersion: 1,
    application: {
      name: rootManifest.name,
      version: rootManifest.version,
      license: "MIT",
      licenseFile: "Loopdrop-LICENSE.txt",
      licenseSha256: sha256(projectLicense),
      thirdPartyNoticesFile: "THIRD_PARTY_NOTICES.md",
      thirdPartyNoticesSha256: sha256(thirdPartyNotices),
    },
    components: {
      electron: {
        version: electron.version,
        licenseFile: "Electron-LICENSE.txt",
        licenseSha256: sha256(electron.artifacts[0].electronLicense),
        versionFile: "Electron-version.txt",
        artifacts: electron.artifacts.map((artifact) => ({
          fileName: artifact.fileName,
          platform: artifact.platform,
          arch: artifact.arch,
          sha256: artifact.sha256,
          chromiumNoticesFile: artifact.chromiumOutput,
          chromiumNoticesSha256: artifact.chromiumSha256,
        })),
      },
      react: {
        version: react.version,
        licenseFile: "React-LICENSE.txt",
        licenseSha256: react.sha256,
      },
      reactDom: {
        version: reactDom.version,
        licenseFile: "React-DOM-LICENSE.txt",
        licenseSha256: reactDom.sha256,
      },
    },
  };
  await writeFile(
    path.join(licenseDir, "LICENSE-MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  console.log(
    `  • packaged licenses  directory=${path.relative(projectDir, licenseDir)} electron=${electron.version}`,
  );
}

module.exports = afterPack;
module.exports.afterPack = afterPack;
module.exports.readZipEntries = readZipEntries;
module.exports.targetArchitectures = targetArchitectures;
