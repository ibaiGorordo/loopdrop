const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const {
  LoopdropError,
  buildFfmpegArgs,
  convertToGif,
  normalizeRequest,
  parseTime,
  safeStem,
} = require("../core/converter.cjs");

test("shared validation enforces one exact 300-frame limit", () => {
  const accepted = normalizeRequest({ inputPath: "video.mp4", duration: 25, fps: 12 });
  assert.equal(Math.ceil(accepted.duration * accepted.fps), 300);
  assert.throws(
    () => normalizeRequest({ inputPath: "video.mp4", duration: 25.01, fps: 12 }),
    (error) => error instanceof LoopdropError && error.code === "FRAME_LIMIT_EXCEEDED",
  );
});

test("time parsing is strict and supports shell-friendly formats", () => {
  assert.equal(parseTime("2.5"), 2.5);
  assert.equal(parseTime("01:02.5"), 62.5);
  assert.equal(parseTime("01:02:03.25"), 3723.25);
  assert.throws(() => parseTime("1:60"), /Invalid time value/);
  assert.throws(() => parseTime("-1"), /Invalid time value/);
});

test("output stems are portable across operating systems", () => {
  assert.equal(safeStem("My clip?.m4v"), "My clip-");
  assert.equal(safeStem("CON.mp4"), "_CON");
  assert.equal(safeStem("  .mp4"), "loopdrop");
  assert.equal(safeStem("日本語.mov"), "日本語");
});

test("FFmpeg arguments seek quickly and assign explicit frame timestamps", () => {
  const settings = normalizeRequest({ inputPath: "source.mp4", start: 3, duration: 2, fps: 12, width: 480 });
  const args = buildFfmpegArgs(settings, "output.gif");
  assert.ok(args.indexOf("-ss") < args.indexOf("-i"));
  assert.match(args[args.indexOf("-filter_complex") + 1], /setpts=N\/\(12\*TB\)/);
  assert.equal(args[args.indexOf("-loop") + 1], "0");
  assert.equal(buildFfmpegArgs(normalizeRequest({ inputPath: "source.mp4", duration: 2 }), "output.gif").includes("-ss"), false);
});

test("forced output rejects a non-file target before conversion without moving it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loopdrop-unsafe-output-test-"));
  const inputPath = join(directory, "source.mp4");
  const outputPath = join(directory, "existing.gif");
  const markerPath = join(outputPath, "keep.txt");

  try {
    await writeFile(inputPath, "input stays untouched");
    await mkdir(outputPath);
    await writeFile(markerPath, "original directory contents");

    await assert.rejects(
      convertToGif(
        { inputPath, outputPath, overwrite: true, duration: 1, fps: 12, width: 160 },
        { ffmpegPath: join(directory, "ffmpeg-must-not-run") },
      ),
      (error) => error instanceof LoopdropError
        && error.code === "OUTPUT_UNSAFE"
        && error.message === "Refusing to overwrite anything except a regular file.",
    );

    assert.equal((await stat(outputPath)).isDirectory(), true);
    assert.equal(await readFile(markerPath, "utf8"), "original directory contents");
    assert.deepEqual((await readdir(directory)).sort(), ["existing.gif", "source.mp4"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
