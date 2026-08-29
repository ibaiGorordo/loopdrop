const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { deflateRawSync } = require("node:zlib");

const afterPack = require("../scripts/after-pack.cjs");
const manifest = require("../package.json");

function createTestZip(entries) {
  const localParts = [];
  const directoryParts = [];
  let localOffset = 0;

  for (const [name, raw, deflate] of entries) {
    const fileName = Buffer.from(name);
    const contents = Buffer.from(raw);
    const compressed = deflate ? deflateRawSync(contents) : contents;
    const method = deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    localParts.push(local, fileName, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(contents.length, 24);
    directory.writeUInt16LE(fileName.length, 28);
    directory.writeUInt32LE(localOffset, 42);
    directoryParts.push(directory, fileName);
    localOffset += local.length + fileName.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(directoryParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

test("desktop packaging uses the deterministic license hook without publishing it to npm", () => {
  assert.equal(manifest.build.afterPack, "scripts/after-pack.cjs");
  assert.equal(manifest.devDependencies["@electron/get"], "5.1.0");
  assert.equal(manifest.devDependencies.electron, "44.0.0");
  assert.equal(manifest.devDependencies.react, "19.2.6");
  assert.equal(manifest.devDependencies["react-dom"], "19.2.6");
  assert.equal(manifest.files.some((pattern) => pattern.startsWith("scripts")), false);
});

test("the selective ZIP reader preserves stored and deflated release files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loopdrop-license-test-"));
  const zipPath = path.join(directory, "artifact.zip");
  const expected = new Map([
    ["LICENSE", Buffer.from("electron license\n")],
    ["LICENSES.chromium.html", Buffer.from("<html>chromium notices</html>\n")],
    ["version", Buffer.from("44.0.0")],
  ]);

  try {
    await writeFile(
      zipPath,
      createTestZip([
        ["ignored", "not extracted", false],
        ["LICENSE", expected.get("LICENSE"), false],
        ["LICENSES.chromium.html", expected.get("LICENSES.chromium.html"), true],
        ["version", expected.get("version"), true],
      ]),
    );
    const actual = await afterPack.readZipEntries(zipPath, [...expected.keys()]);
    for (const [name, contents] of expected) {
      assert.deepEqual(actual.get(name), contents);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("all macOS packages use identical notice inputs for safe universal merging", () => {
  assert.deepEqual(afterPack.targetArchitectures("darwin", 4), ["x64", "arm64"]);
  assert.deepEqual(afterPack.targetArchitectures("darwin", 3), ["x64", "arm64"]);
  assert.deepEqual(afterPack.targetArchitectures("darwin", 1), ["x64", "arm64"]);
  assert.deepEqual(afterPack.targetArchitectures("linux", 3), ["arm64"]);
  assert.throws(() => afterPack.targetArchitectures("win32", 4), /only supported on macOS/);
});

test("source notices disclose exact packaged Electron and React licenses", async () => {
  const notices = await readFile(path.join(__dirname, "..", "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(notices, /Electron 44\.0\.0/);
  assert.match(notices, /LICENSES\.chromium\.html/);
  assert.match(notices, /checksum-verified Electron/);
  assert.match(notices, /React 19\.2\.6 and React DOM 19\.2\.6/);
});
