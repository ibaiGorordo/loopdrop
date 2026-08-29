const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { gzipSync } = require("node:zlib");
const yaml = require("js-yaml");

const {
  targetDefinition,
  verifyAppUpdateConfig,
  verifyUpdateAssets,
} = require("../.github/scripts/verify-update-assets.cjs");

function digest(contents) {
  return createHash("sha512").update(contents).digest("base64");
}

function blockmap(contents) {
  return gzipSync(JSON.stringify({
    version: "2",
    files: [{ name: "file", offset: 0, checksums: ["fixture-checksum"], sizes: [contents.length] }],
  }));
}

async function writeAppUpdate(directory, extra = {}) {
  const appUpdatePath = path.join(directory, "app-update.yml");
  await writeFile(appUpdatePath, yaml.dump({
    provider: "github",
    owner: "ibaiGorordo",
    repo: "loopdrop",
    releaseType: "release",
    updaterCacheDirName: "loopdrop-updater",
    ...extra,
  }));
  return appUpdatePath;
}

async function createMacFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopdrop-update-assets-"));
  const version = "1.2.3";
  const definition = targetDefinition("mac-universal", version);
  const entries = [];
  for (const [index, name] of definition.payloads.entries()) {
    const contents = Buffer.from(`payload-${index}-${name}`);
    await writeFile(path.join(directory, name), contents);
    entries.push({ url: name, sha512: digest(contents), size: contents.length });
  }
  for (const name of definition.blockmaps) {
    const payload = entries.find((entry) => `${entry.url}.blockmap` === name);
    const contents = Buffer.from(`payload-${definition.payloads.indexOf(payload.url)}-${payload.url}`);
    await writeFile(path.join(directory, name), blockmap(contents));
  }
  await writeFile(path.join(directory, definition.manifest), yaml.dump({
    version,
    files: entries,
    path: definition.primary,
    sha512: entries.find((entry) => entry.url === definition.primary).sha512,
    releaseDate: "2026-08-29T00:00:00.000Z",
  }));
  const appUpdatePath = await writeAppUpdate(directory);
  return { appUpdatePath, definition, directory, entries, version };
}

test("release updater metadata names and hashes every macOS payload exactly", async () => {
  const fixture = await createMacFixture();
  try {
    const result = await verifyUpdateAssets({
      kind: "mac-universal",
      version: fixture.version,
      directory: fixture.directory,
      appUpdatePath: fixture.appUpdatePath,
    });
    assert.deepEqual(result.payloads, fixture.definition.payloads);
    assert.equal(result.manifest, "latest-mac.yml");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("release updater metadata rejects an artifact changed after manifest creation", async () => {
  const fixture = await createMacFixture();
  try {
    await writeFile(path.join(fixture.directory, fixture.definition.primary), "tampered");
    await assert.rejects(
      verifyUpdateAssets({
        kind: "mac-universal",
        version: fixture.version,
        directory: fixture.directory,
        appUpdatePath: fixture.appUpdatePath,
      }),
      /size does not match|SHA-512 does not match/,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("signed Windows updater configuration must retain a publisher identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopdrop-update-win-"));
  const version = "1.2.3";
  const definition = targetDefinition("win-x64", version);
  const payload = Buffer.from("signed-installer-fixture");
  const payloadName = definition.primary;
  const appUpdatePath = path.join(directory, "app-update.yml");
  try {
    await writeFile(path.join(directory, payloadName), payload);
    await writeFile(path.join(directory, definition.blockmaps[0]), blockmap(payload));
    await writeFile(path.join(directory, definition.manifest), yaml.dump({
      version,
      files: [{ url: payloadName, sha512: digest(payload), size: payload.length }],
      path: payloadName,
      sha512: digest(payload),
      releaseDate: "2026-08-29T00:00:00.000Z",
    }));
    await writeAppUpdate(directory);

    await assert.rejects(
      verifyUpdateAssets({ kind: "win-x64", version, directory, appUpdatePath }),
      /publisherName/,
    );

    await writeAppUpdate(directory, { publisherName: ["Loopdrop Publisher"] });
    const result = await verifyUpdateAssets({ kind: "win-x64", version, directory, appUpdatePath });
    assert.deepEqual(result.publishers, ["Loopdrop Publisher"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux updater manifests stay architecture-specific", () => {
  assert.deepEqual(targetDefinition("linux-x64", "1.2.3").payloads, [
    "loopdrop-1.2.3-linux-x86_64.AppImage",
    "loopdrop-1.2.3-linux-amd64.deb",
  ]);
  assert.deepEqual(targetDefinition("linux-arm64", "1.2.3").payloads, [
    "loopdrop-1.2.3-linux-arm64.AppImage",
    "loopdrop-1.2.3-linux-arm64.deb",
  ]);
});

for (const [kind, selectedPayloadIndex] of [["linux-x64", 1], ["linux-arm64", 0]]) {
  test(`${kind} accepts either matching-architecture payload as the generated primary`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), `loopdrop-update-${kind}-`));
    const version = "1.2.3";
    const definition = targetDefinition(kind, version);
    const entries = [];
    try {
      for (const [index, name] of definition.payloads.entries()) {
        const contents = Buffer.from(`${kind}-payload-${index}`);
        await writeFile(path.join(directory, name), contents);
        entries.unshift({ url: name, sha512: digest(contents), size: contents.length });
      }
      const primary = definition.payloads[selectedPayloadIndex];
      await writeFile(path.join(directory, definition.manifest), yaml.dump({
        version,
        files: entries,
        path: primary,
        sha512: entries.find((entry) => entry.url === primary).sha512,
        releaseDate: "2026-08-29T00:00:00.000Z",
      }));
      const appUpdatePath = await writeAppUpdate(directory);
      const result = await verifyUpdateAssets({ kind, version, directory, appUpdatePath });
      assert.equal(result.primary, primary);
      assert.deepEqual(result.payloads, definition.payloads);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("blockmaps must describe the corresponding payload size", async () => {
  const fixture = await createMacFixture();
  try {
    const blockmapPath = path.join(fixture.directory, fixture.definition.blockmaps[0]);
    await writeFile(blockmapPath, blockmap(Buffer.from("wrong-sized-payload")));
    await assert.rejects(
      verifyUpdateAssets({
        kind: "mac-universal",
        version: fixture.version,
        directory: fixture.directory,
        appUpdatePath: fixture.appUpdatePath,
      }),
      /Blockmap does not describe its payload exactly/,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("packaged updater configuration rejects prerelease channels and DN-style publishers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopdrop-update-config-"));
  try {
    const appUpdatePath = await writeAppUpdate(directory, {
      channel: "beta",
      publisherName: ["CN=Loopdrop Publisher"],
    });
    await assert.rejects(
      verifyAppUpdateConfig(appUpdatePath, { requirePublisher: true }),
      /stable latest channel/,
    );
    await writeAppUpdate(directory, { channel: "latest", publisherName: ["CN=Loopdrop Publisher"] });
    await assert.rejects(
      verifyAppUpdateConfig(appUpdatePath, { requirePublisher: true }),
      /common name, not a distinguished name/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("packaged updater configuration cannot reroute or privatize the public update feed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopdrop-update-routing-"));
  const cases = [
    [{ host: "updates.example.invalid" }, /canonical HTTPS GitHub endpoint/],
    [{ protocol: "http" }, /canonical HTTPS GitHub endpoint/],
    [{ private: true }, /public GitHub release provider/],
    [{ token: "embedded-secret" }, /must not contain a GitHub token/],
  ];
  try {
    for (const [extra, expected] of cases) {
      const appUpdatePath = await writeAppUpdate(directory, extra);
      await assert.rejects(verifyAppUpdateConfig(appUpdatePath, { requirePublisher: false }), expected);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
