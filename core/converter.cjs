const { spawn } = require("node:child_process");
const { constants, existsSync } = require("node:fs");
const { copyFile, link, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, unlink } = require("node:fs/promises");
const { basename, dirname, extname, join, parse, resolve } = require("node:path");
const { performance } = require("node:perf_hooks");

const MAX_FRAMES = 300;
const MAX_DURATION_SECONDS = 60;
const MAX_DIMENSION = 3840;

class LoopdropError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "LoopdropError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function numeric(value, name, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new LoopdropError("INVALID_ARGUMENT", `${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function normalizeSizing(request) {
  const hasWidth = request.width !== undefined && request.width !== null;
  const hasHeight = request.height !== undefined && request.height !== null;
  if (!hasWidth && !hasHeight) return { mode: "width", width: 480 };
  if (hasWidth && hasHeight) {
    return {
      mode: "exact",
      width: Math.round(numeric(request.width, "width", 2, MAX_DIMENSION)),
      height: Math.round(numeric(request.height, "height", 2, MAX_DIMENSION)),
    };
  }
  if (hasWidth) return { mode: "width", width: Math.round(numeric(request.width, "width", 2, MAX_DIMENSION)) };
  return { mode: "height", height: Math.round(numeric(request.height, "height", 2, MAX_DIMENSION)) };
}

function normalizeRequest(request) {
  if (!request || typeof request !== "object") {
    throw new LoopdropError("INVALID_ARGUMENT", "A conversion request is required.");
  }
  if (typeof request.inputPath !== "string" || request.inputPath.trim() === "") {
    throw new LoopdropError("INVALID_ARGUMENT", "inputPath is required.");
  }

  const start = numeric(request.start ?? 0, "start", 0, 86400);
  const duration = numeric(request.duration, "duration", 0.05, MAX_DURATION_SECONDS);
  const fps = numeric(request.fps ?? 12, "fps", 1, 30);
  const colors = Math.round(numeric(request.colors ?? 128, "colors", 4, 256));
  if (Math.ceil(duration * fps) > MAX_FRAMES) {
    throw new LoopdropError(
      "FRAME_LIMIT_EXCEEDED",
      `This conversion would create more than ${MAX_FRAMES} frames. Shorten it or lower FPS.`,
    );
  }

  return {
    inputPath: resolve(request.inputPath),
    start,
    duration,
    fps,
    colors,
    loop: request.loop !== false,
    sizing: normalizeSizing(request),
  };
}

function scaleExpression(sizing) {
  if (sizing.mode === "exact") return `${sizing.width}:${sizing.height}`;
  if (sizing.mode === "height") return `-2:${sizing.height}`;
  return `${sizing.width}:-2`;
}

function filterGraph(settings) {
  return [
    `fps=${settings.fps},setpts=N/(${settings.fps}*TB),scale=${scaleExpression(settings.sizing)}:flags=lanczos,split[gif][palette]`,
    `[palette]palettegen=max_colors=${settings.colors}:reserve_transparent=0:stats_mode=diff[paletteout]`,
    "[gif][paletteout]paletteuse=dither=sierra2_4a:diff_mode=rectangle[out]",
  ].join(";");
}

function buildFfmpegArgs(settings, temporaryOutput, options = {}) {
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
  ];
  if (settings.start > 0 && !options.accurateSeek) args.push("-ss", settings.start.toString());
  args.push("-i", settings.inputPath);
  if (settings.start > 0 && options.accurateSeek) args.push("-ss", settings.start.toString());
  args.push(
    "-t", settings.duration.toString(),
    "-filter_complex", filterGraph(settings),
    "-map", "[out]",
    "-an",
    "-loop", settings.loop ? "0" : "-1",
    "-progress", "pipe:1",
    "-nostats",
    temporaryOutput,
  );
  return args;
}

function parseTime(value) {
  if (typeof value === "number") return numeric(value, "time", 0, 86400);
  if (typeof value !== "string" || value.trim() === "") {
    throw new LoopdropError("INVALID_ARGUMENT", "Time values must be seconds or HH:MM:SS.");
  }
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return numeric(Number(text), "time", 0, 86400);
  const parts = text.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) {
    throw new LoopdropError("INVALID_ARGUMENT", `Invalid time value: ${value}`);
  }
  const secondsPart = Number(parts.at(-1));
  const minutesPart = parts.length === 3 ? Number(parts[1]) : null;
  if (secondsPart >= 60 || (minutesPart !== null && minutesPart >= 60)) {
    throw new LoopdropError("INVALID_ARGUMENT", `Invalid time value: ${value}`);
  }
  const seconds = parts.reverse().reduce((total, part, index) => total + Number(part) * (60 ** index), 0);
  return numeric(seconds, "time", 0, 86400);
}

function safeStem(filename) {
  let stem = parse(filename).name
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 120) || "loopdrop";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;
  return stem;
}

function normalizeExplicitOutput(outputPath) {
  const absolute = resolve(outputPath);
  const extension = extname(absolute);
  if (!extension) return `${absolute}.gif`;
  if (extension.toLowerCase() !== ".gif") {
    throw new LoopdropError("INVALID_ARGUMENT", "The output file must use the .gif extension.");
  }
  return absolute;
}

function candidatePath(directory, stem, suffix) {
  return join(directory, suffix === 1 ? `${stem}.gif` : `${stem}-${suffix}.gif`);
}

async function finalizeNoClobber(temporaryOutput, desiredOutput, allowSuffix) {
  const directory = dirname(desiredOutput);
  const stem = safeStem(basename(desiredOutput));
  let suffix = 1;
  while (true) {
    const candidate = allowSuffix ? candidatePath(directory, stem, suffix) : desiredOutput;
    try {
      await link(temporaryOutput, candidate);
      await unlink(temporaryOutput);
      return candidate;
    } catch (error) {
      if (error && error.code === "EEXIST" && allowSuffix) {
        suffix += 1;
        continue;
      }
      if (error && ["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(error.code)) {
        try {
          await copyFile(temporaryOutput, candidate, constants.COPYFILE_EXCL);
          await unlink(temporaryOutput);
          return candidate;
        } catch (copyError) {
          if (copyError && copyError.code === "EEXIST" && allowSuffix) {
            suffix += 1;
            continue;
          }
          if (copyError && copyError.code === "EEXIST") {
            throw new LoopdropError("OUTPUT_EXISTS", `Output already exists: ${candidate}`);
          }
          throw copyError;
        }
      }
      if (error && error.code === "EEXIST") {
        throw new LoopdropError("OUTPUT_EXISTS", `Output already exists: ${candidate}`);
      }
      throw error;
    }
  }
}

async function finalizeOverwrite(temporaryOutput, outputPath) {
  const backup = join(dirname(outputPath), `.loopdrop-backup-${process.pid}-${Date.now()}.gif`);
  const hadOutput = existsSync(outputPath);
  if (hadOutput) await rename(outputPath, backup);
  try {
    await rename(temporaryOutput, outputPath);
    if (hadOutput) await rm(backup, { force: true });
    return outputPath;
  } catch (error) {
    if (hadOutput && existsSync(backup)) await rename(backup, outputPath);
    throw error;
  }
}

function runFfmpeg(ffmpegPath, args, settings, { signal, onProgress, onProcess } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stderr = "";
    let progressBuffer = "";
    let aborted = Boolean(signal?.aborted);
    let killTimer;
    let settled = false;
    const child = spawn(ffmpegPath, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    onProcess?.(child);

    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      killTimer.unref?.();
    };

    if (aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("out_time_us=")) continue;
        const microseconds = Number(line.slice("out_time_us=".length));
        if (!Number.isFinite(microseconds) || microseconds < 0) continue;
        const ratio = Math.min(0.99, Math.max(0, microseconds / (settings.duration * 1_000_000)));
        onProgress?.({ phase: "encoding", ratio, percent: Math.round(ratio * 100), outTimeMs: Math.round(microseconds / 1000) });
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 24000) stderr += chunk.toString();
    });
    child.once("error", (error) => settle(new LoopdropError("FFMPEG_START_FAILED", error.message)));
    child.once("exit", (code) => {
      if (aborted) settle(new LoopdropError("CANCELLED", "Conversion cancelled."));
      else if (code === 0) settle();
      else settle(new LoopdropError("FFMPEG_FAILED", stderr.trim() || `FFmpeg stopped with code ${code}.`));
    });
  });
}

async function probeVideo(inputPath, ffprobePath) {
  const absoluteInput = resolve(inputPath);
  let inputStats;
  try {
    inputStats = await stat(absoluteInput);
  } catch {
    throw new LoopdropError("INPUT_NOT_FOUND", `Input file not found: ${absoluteInput}`);
  }
  if (!inputStats.isFile()) throw new LoopdropError("INPUT_NOT_FILE", "The input path must be a regular file.");

  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,avg_frame_rate,nb_frames,duration:format=duration",
    "-of", "json",
    absoluteInput,
  ];
  const output = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(ffprobePath, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => rejectPromise(new LoopdropError("FFPROBE_START_FAILED", error.message)));
    child.once("exit", (code) => code === 0
      ? resolvePromise(stdout)
      : rejectPromise(new LoopdropError("PROBE_FAILED", stderr.trim() || `ffprobe stopped with code ${code}.`)));
  });
  const parsed = JSON.parse(output);
  const stream = parsed.streams?.[0];
  if (!stream) throw new LoopdropError("NO_VIDEO_STREAM", "No video stream was found in this file.");
  const rateParts = String(stream.avg_frame_rate || "0/1").split("/").map(Number);
  const frameRate = rateParts[1] ? rateParts[0] / rateParts[1] : 0;
  const duration = Number(stream.duration || parsed.format?.duration || 0);
  return {
    inputPath: absoluteInput,
    width: Number(stream.width),
    height: Number(stream.height),
    durationSeconds: duration,
    frameRate,
    frames: Number(stream.nb_frames) || null,
    sizeBytes: inputStats.size,
  };
}

async function convertToGif(request, options = {}) {
  const startedAt = performance.now();
  const settings = normalizeRequest(request);
  let inputStats;
  try {
    inputStats = await stat(settings.inputPath);
  } catch {
    throw new LoopdropError("INPUT_NOT_FOUND", `Input file not found: ${settings.inputPath}`);
  }
  if (!inputStats.isFile()) throw new LoopdropError("INPUT_NOT_FILE", "The input path must be a regular file.");

  const explicitOutput = request.outputPath ? normalizeExplicitOutput(request.outputPath) : null;
  const outputDirectory = explicitOutput
    ? dirname(explicitOutput)
    : resolve(request.outputDirectory || process.cwd());
  await mkdir(outputDirectory, { recursive: true });
  const desiredOutput = explicitOutput || join(outputDirectory, `${safeStem(basename(settings.inputPath))}.gif`);
  if (resolve(desiredOutput) === settings.inputPath) throw new LoopdropError("INVALID_ARGUMENT", "Input and output paths must differ.");
  if (explicitOutput && existsSync(explicitOutput) && !request.overwrite) {
    throw new LoopdropError("OUTPUT_EXISTS", `Output already exists: ${explicitOutput}`);
  }
  if (explicitOutput && request.overwrite && existsSync(explicitOutput)) {
    const outputStats = await lstat(explicitOutput);
    if (!outputStats.isFile()) {
      throw new LoopdropError("OUTPUT_UNSAFE", "Refusing to overwrite anything except a regular file.");
    }
  }

  const temporaryDirectory = await mkdtemp(join(outputDirectory, ".loopdrop-tmp-"));
  const temporaryOutput = join(temporaryDirectory, "output.gif");
  const ffmpegPath = options.ffmpegPath || "ffmpeg";
  options.onProgress?.({ phase: "starting", ratio: 0, percent: 0, outTimeMs: 0 });
  try {
    try {
      await runFfmpeg(ffmpegPath, buildFfmpegArgs(settings, temporaryOutput), settings, options);
    } catch (error) {
      const canRetryAccurately = settings.start > 0
        && error instanceof LoopdropError
        && error.code === "FFMPEG_FAILED"
        && !options.signal?.aborted;
      if (!canRetryAccurately) throw error;
      await rm(temporaryOutput, { force: true });
      options.onProgress?.({ phase: "starting", ratio: 0, percent: 0, outTimeMs: 0 });
      await runFfmpeg(
        ffmpegPath,
        buildFfmpegArgs(settings, temporaryOutput, { accurateSeek: true }),
        settings,
        options,
      );
    }
    let outputPath;
    if (explicitOutput && request.overwrite) outputPath = await finalizeOverwrite(temporaryOutput, explicitOutput);
    else outputPath = await finalizeNoClobber(temporaryOutput, desiredOutput, !explicitOutput);
    const outputStats = await stat(outputPath);
    options.onProgress?.({ phase: "complete", ratio: 1, percent: 100, outTimeMs: Math.round(settings.duration * 1000) });
    return {
      inputPath: settings.inputPath,
      outputPath,
      sizeBytes: outputStats.size,
      durationSeconds: settings.duration,
      frames: Math.ceil(settings.duration * settings.fps),
      fps: settings.fps,
      colors: settings.colors,
      loop: settings.loop,
      sizing: settings.sizing,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  MAX_DURATION_SECONDS,
  MAX_FRAMES,
  MAX_DIMENSION,
  LoopdropError,
  buildFfmpegArgs,
  convertToGif,
  filterGraph,
  normalizeRequest,
  parseTime,
  probeVideo,
  safeStem,
};
