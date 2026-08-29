const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtemp, readFile, readdir, rm, stat, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { resolveBinary } = require("../core/binaries.cjs");
const { convertToGif, probeVideo } = require("../core/converter.cjs");

const ffmpegPath = resolveBinary("ffmpeg");
const ffprobePath = resolveBinary("ffprobe");
const binaryAvailable = spawnSync(ffmpegPath, ["-version"], { stdio: "ignore" }).status === 0
  && spawnSync(ffprobePath, ["-version"], { stdio: "ignore" }).status === 0;

async function writePpmFrames(directory, count = 24, width = 96, height = 54) {
  for (let frame = 0; frame < count; frame += 1) {
    const pixels = Buffer.alloc(width * height * 3);
    const blockStart = (frame * 4) % width;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3;
        const inBlock = x >= blockStart && x < Math.min(width, blockStart + 18);
        pixels[offset] = inBlock ? 250 : Math.round((x / width) * 80);
        pixels[offset + 1] = inBlock ? Math.round((y / height) * 255) : 20;
        pixels[offset + 2] = inBlock ? 45 : Math.round((frame / count) * 120);
      }
    }
    const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
    await writeFile(join(directory, `frame-${String(frame).padStart(3, "0")}.ppm`), Buffer.concat([header, pixels]));
  }
}

test("redistributable native engine creates a correctly paced GIF", { skip: !binaryAvailable, timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "loopdrop-test-"));
  const source = join(directory, "source clip 日本語.mp4");
  const output = join(directory, "output animation.gif");

  try {
    await writePpmFrames(directory);
    const fixture = spawnSync(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-framerate", "12",
      "-start_number", "0",
      "-i", join(directory, "frame-%03d.ppm"),
      "-frames:v", "24",
      "-c:v", "mpeg4",
      "-pix_fmt", "yuv420p",
      source,
    ]);
    assert.equal(fixture.status, 0, fixture.stderr.toString());

    const result = await convertToGif(
      {
        inputPath: source,
        outputPath: output,
        start: 0.25,
        duration: 1,
        fps: 12,
        width: 160,
        colors: 64,
        loop: true,
      },
      { ffmpegPath },
    );

    assert.equal(result.outputPath, output);
    assert.equal(result.frames, 12);
    assert.ok((await stat(output)).size > 1000);
    assert.match((await readFile(output)).subarray(0, 6).toString(), /^GIF8[79]a$/);

    const inspection = await probeVideo(output, ffprobePath);
    assert.equal(inspection.width, 160);
    assert.equal(inspection.height, 90);
    assert.ok(inspection.durationSeconds >= 0.9 && inspection.durationSeconds <= 1.1, `duration was ${inspection.durationSeconds}`);
    assert.ok(inspection.frames === null || (inspection.frames >= 11 && inspection.frames <= 13));

    await assert.rejects(
      convertToGif(
        { inputPath: source, outputPath: output, duration: 1, fps: 12, width: 160 },
        { ffmpegPath },
      ),
      (error) => error.code === "OUTPUT_EXISTS",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an aborted conversion leaves no destination or owned temp directory", { skip: !binaryAvailable, timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "loopdrop-cancel-test-"));
  const source = join(directory, "source.mp4");
  const output = join(directory, "cancelled.gif");

  try {
    await writePpmFrames(directory, 2, 32, 18);
    const fixture = spawnSync(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-framerate", "2", "-start_number", "0", "-i", join(directory, "frame-%03d.ppm"),
      "-frames:v", "2", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", source,
    ]);
    assert.equal(fixture.status, 0, fixture.stderr.toString());
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      convertToGif(
        { inputPath: source, outputPath: output, duration: 1, fps: 12, width: 160 },
        { ffmpegPath, signal: controller.signal },
      ),
      (error) => error.code === "CANCELLED",
    );
    await assert.rejects(stat(output), (error) => error.code === "ENOENT");
    const leftovers = (await readdir(directory)).filter((name) => name.startsWith(".loopdrop-tmp-"));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
