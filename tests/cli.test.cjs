const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");

const cliUrl = pathToFileURL(join(__dirname, "..", "cli", "loopdrop.mjs")).href;

function capture(isTTY = false) {
  let contents = "";
  return {
    isTTY,
    write(chunk) {
      contents += String(chunk);
      return true;
    },
    text() {
      return contents;
    },
  };
}

function fakeResult(overrides = {}) {
  return {
    inputPath: "/work/source.mp4",
    outputPath: "/work/source.gif",
    sizeBytes: 2048,
    durationSeconds: 2,
    frames: 24,
    fps: 12,
    colors: 128,
    loop: true,
    sizing: { mode: "width", width: 480 },
    elapsedMs: 25,
    ...overrides,
  };
}

test("parser supports the default form and all conversion value types", async () => {
  const { parseCliArguments } = await import(cliUrl);
  const parsed = parseCliArguments([
    "source clip.mov",
    "--output", "result.gif",
    "--start", "1:02.5",
    "--end", "1:04.5",
    "--size", "640x360",
    "--fps=15",
    "--colors", "64",
    "--no-loop",
    "--force",
    "--json",
    "--progress=json",
  ]);

  assert.equal(parsed.command, "convert");
  assert.equal(parsed.inputPath, "source clip.mov");
  assert.equal(parsed.outputPath, "result.gif");
  assert.equal(parsed.start, 62.5);
  assert.equal(parsed.duration, 2);
  assert.deepEqual(parsed.size, { width: 640, height: 360 });
  assert.equal(parsed.fps, 15);
  assert.equal(parsed.colors, 64);
  assert.equal(parsed.loop, false);
  assert.equal(parsed.force, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.progress, "json");
});

test("parser rejects ambiguous ranges, sizing, and unsafe force defaults", async () => {
  const { parseCliArguments } = await import(cliUrl);
  assert.throws(
    () => parseCliArguments(["source.mp4", "--duration", "2", "--end", "3"]),
    /only one of --duration and --end/,
  );
  assert.throws(
    () => parseCliArguments(["source.mp4", "--width", "640", "--height", "360"]),
    /only one of --width, --height, and --size/,
  );
  assert.throws(
    () => parseCliArguments(["source.mp4", "--force"]),
    /requires an explicit --output/,
  );
});

test("JSON conversion keeps the final result on stdout and progress JSON on stderr", async () => {
  const { runCli } = await import(cliUrl);
  const stdout = capture();
  const stderr = capture();
  let receivedRequest;
  const code = await runCli([
    "convert", "source.mp4",
    "--duration", "2",
    "--json",
    "--progress", "json",
  ], {
    io: { stdout, stderr },
    cwd: () => "/work",
    processLike: new EventEmitter(),
    dependencies: {
      randomUUID: () => "job-123",
      resolveBinary: (name) => `/bin/${name}`,
      convertToGif: async (request, options) => {
        receivedRequest = request;
        options.onProgress({ phase: "starting", ratio: 0, percent: 0, outTimeMs: 0 });
        options.onProgress({ phase: "encoding", ratio: 0.5, percent: 50, outTimeMs: 1000 });
        options.onProgress({ phase: "complete", ratio: 1, percent: 100, outTimeMs: 2000 });
        return fakeResult();
      },
    },
  });

  assert.equal(code, 0);
  assert.equal(receivedRequest.duration, 2);
  assert.equal(receivedRequest.outputDirectory, "/work");
  const result = JSON.parse(stdout.text());
  assert.deepEqual(
    { ok: result.ok, command: result.command, jobId: result.jobId, outputPath: result.outputPath, durationMs: result.durationMs },
    { ok: true, command: "convert", jobId: "job-123", outputPath: "/work/source.gif", durationMs: 2000 },
  );
  const events = stderr.text().trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => [event.type, event.phase, event.percent]), [
    ["progress", "starting", 0],
    ["progress", "encoding", 50],
    ["progress", "complete", 100],
  ]);
});

test("non-TTY auto progress stays silent and normal stdout is only the output path", async () => {
  const { runCli } = await import(cliUrl);
  const stdout = capture();
  const stderr = capture(false);
  const code = await runCli(["source.mp4", "--duration", "1"], {
    io: { stdout, stderr },
    processLike: new EventEmitter(),
    dependencies: {
      randomUUID: () => "job",
      resolveBinary: () => "ffmpeg",
      convertToGif: async (_request, options) => {
        options.onProgress({ phase: "encoding", ratio: 0.5, percent: 50, outTimeMs: 500 });
        return fakeResult({ durationSeconds: 1, frames: 12 });
      },
    },
  });

  assert.equal(code, 0);
  assert.equal(stdout.text(), "/work/source.gif\n");
  assert.equal(stderr.text(), "");
});

test("default duration uses probe metadata and caps the clip at ten seconds", async () => {
  const { runCli } = await import(cliUrl);
  const stdout = capture();
  const stderr = capture();
  let receivedDuration;
  const code = await runCli(["source.mp4", "--start", "5"], {
    io: { stdout, stderr },
    processLike: new EventEmitter(),
    dependencies: {
      randomUUID: () => "job",
      resolveBinary: (name) => name,
      probeVideo: async () => ({ durationSeconds: 12 }),
      convertToGif: async (request) => {
        receivedDuration = request.duration;
        return fakeResult({ durationSeconds: request.duration, frames: 84 });
      },
    },
  });

  assert.equal(code, 0);
  assert.equal(receivedDuration, 7);
  assert.equal(stderr.text(), "");
});

test("JSON failures are parseable on stdout and retain stable exit mappings", async () => {
  const { runCli } = await import(cliUrl);
  const stdout = capture();
  const stderr = capture();
  const failure = Object.assign(new Error("Output already exists: /work/out.gif"), { code: "OUTPUT_EXISTS" });
  const code = await runCli([
    "source.mp4", "--duration", "1", "--output", "/work/out.gif", "--json",
  ], {
    io: { stdout, stderr },
    processLike: new EventEmitter(),
    dependencies: {
      randomUUID: () => "job",
      resolveBinary: () => "ffmpeg",
      convertToGif: async () => { throw failure; },
    },
  });

  assert.equal(code, 4);
  assert.deepEqual(JSON.parse(stdout.text()), {
    schemaVersion: 1,
    ok: false,
    error: {
      code: "OUTPUT_EXISTS",
      message: "Output already exists: /work/out.gif",
    },
  });
  assert.equal(stderr.text(), "");
});

test("unsafe overwrite targets retain the stable filesystem exit mapping", async () => {
  const { runCli } = await import(cliUrl);
  const stdout = capture();
  const stderr = capture();
  const failure = Object.assign(
    new Error("Refusing to overwrite anything except a regular file."),
    { code: "OUTPUT_UNSAFE" },
  );
  const code = await runCli([
    "source.mp4", "--duration", "1", "--output", "/work/existing.gif", "--force", "--json",
  ], {
    io: { stdout, stderr },
    processLike: new EventEmitter(),
    dependencies: {
      randomUUID: () => "job",
      resolveBinary: () => "ffmpeg",
      convertToGif: async () => { throw failure; },
    },
  });

  assert.equal(code, 4);
  assert.deepEqual(JSON.parse(stdout.text()), {
    schemaVersion: 1,
    ok: false,
    error: {
      code: "OUTPUT_UNSAFE",
      message: "Refusing to overwrite anything except a regular file.",
    },
  });
  assert.equal(stderr.text(), "");
});

test("argument errors also use the JSON failure envelope when requested", async () => {
  const { runCli } = await import(cliUrl);
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(["source.mp4", "--duration", "1", "--end", "2", "--json"], {
    io: { stdout, stderr },
    processLike: new EventEmitter(),
  });

  assert.equal(code, 2);
  assert.equal(JSON.parse(stdout.text()).error.code, "INVALID_ARGUMENT");
  assert.equal(stderr.text(), "");
});

test("inspect emits stable JSON without conversion output", async () => {
  const { runCli } = await import(cliUrl);
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(["inspect", "source.mp4", "--json"], {
    io: { stdout, stderr },
    processLike: new EventEmitter(),
    dependencies: {
      resolveBinary: () => "ffprobe",
      probeVideo: async () => ({
        inputPath: "/work/source.mp4",
        width: 320,
        height: 180,
        durationSeconds: 1.25,
        frameRate: 24,
        frames: 30,
        sizeBytes: 1000,
      }),
    },
  });

  assert.equal(code, 0);
  const result = JSON.parse(stdout.text());
  assert.equal(result.command, "inspect");
  assert.equal(result.durationMs, 1250);
  assert.equal(result.width, 320);
  assert.equal(stderr.text(), "");
});

test("mcp delegates to the shared stdio server without writing output", async () => {
  const { runCli } = await import(cliUrl);
  const stdout = capture();
  const stderr = capture();
  let started = 0;
  const code = await runCli(["mcp"], {
    io: { stdout, stderr },
    processLike: new EventEmitter(),
    dependencies: { startMcp: async () => { started += 1; } },
  });
  assert.equal(code, 0);
  assert.equal(started, 1);
  assert.equal(stdout.text(), "");
  assert.equal(stderr.text(), "");
});

test("SIGINT aborts conversion, escalates on a second signal, and exits 130", async () => {
  const { runCli } = await import(cliUrl);
  const stdout = capture();
  const stderr = capture();
  const processLike = new EventEmitter();
  const child = { kills: [], kill(signal) { this.kills.push(signal); } };
  const code = await runCli(["source.mp4", "--duration", "1", "--json"], {
    io: { stdout, stderr },
    processLike,
    dependencies: {
      randomUUID: () => "job",
      resolveBinary: () => "ffmpeg",
      convertToGif: (_request, options) => new Promise((_resolve, reject) => {
        options.onProcess(child);
        options.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("Conversion cancelled."), { code: "CANCELLED" }));
        }, { once: true });
        queueMicrotask(() => {
          processLike.emit("SIGINT");
          processLike.emit("SIGINT");
        });
      }),
    },
  });

  assert.equal(code, 130);
  assert.equal(JSON.parse(stdout.text()).error.code, "CANCELLED");
  assert.deepEqual(child.kills, ["SIGKILL"]);
  assert.equal(processLike.listenerCount("SIGINT"), 0);
  assert.equal(processLike.listenerCount("SIGTERM"), 0);
});
