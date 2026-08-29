#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import converter from "../core/converter.cjs";
import binaries from "../core/binaries.cjs";

const {
  LoopdropError,
  convertToGif,
  parseTime,
  probeVideo,
} = converter;
const { resolveBinary } = binaries;

export const SCHEMA_VERSION = 1;

export const VERSION = (() => {
  for (const filename of ["package.json", "package-lock.json"]) {
    try {
      const manifest = JSON.parse(readFileSync(new URL(`../${filename}`, import.meta.url), "utf8"));
      const version = manifest.version || manifest.packages?.[""]?.version;
      if (typeof version === "string" && version) return version;
    } catch {
      // A standalone build may not include either project manifest.
    }
  }
  return "0.0.0";
})();

const GENERAL_HELP = `loopdrop ${VERSION} — private, on-device video to GIF conversion

Usage:
  loopdrop <input> [options]
  loopdrop convert <input> [options]
  loopdrop inspect <input> [--json]
  loopdrop mcp

Convert options:
  -o, --output <path>       Output GIF (defaults to ./<input-name>.gif)
      --start <time>        Start time in seconds or [[HH:]MM:]SS[.mmm] (default: 0)
      --duration <time>     Clip duration (default: up to 10 seconds)
      --end <time>          End time; cannot be combined with --duration
      --width <pixels>      Preserve aspect ratio at this width (default: 480)
      --height <pixels>     Preserve aspect ratio at this height
      --size <WxH>          Use exact output dimensions
      --fps <number>        Frames per second, 1–30 (default: 12)
      --colors <number>     GIF palette colors, 4–256 (default: 128)
      --loop                Loop continuously (default)
      --no-loop             Play once
  -f, --force               Replace an explicitly named output
      --json                Emit one machine-readable result on stdout
      --progress <mode>     auto, always, never, or json (default: auto)
  -h, --help                Show help
  -V, --version             Show version

Examples:
  loopdrop clip.mp4
  loopdrop clip.mp4 --start 2.5 --duration 4 --width 640
  loopdrop convert clip.mov -o reaction.gif --json --progress json
`;

const INSPECT_HELP = `Usage: loopdrop inspect <input> [--json]

Read video metadata locally with FFprobe.

Options:
      --json       Emit one machine-readable result on stdout
  -h, --help       Show help
  -V, --version    Show version
`;

const MCP_HELP = `Usage: loopdrop mcp

Start loopdrop's Model Context Protocol server over stdio.
`;

class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliUsageError";
    this.code = "INVALID_ARGUMENT";
  }
}

function usageError(message) {
  throw new CliUsageError(message);
}

function optionValue(argv, index, name, inlineValue) {
  if (inlineValue !== undefined) {
    if (inlineValue === "") usageError(`${name} requires a value.`);
    return { value: inlineValue, nextIndex: index };
  }
  if (index + 1 >= argv.length || argv[index + 1] === "--") {
    usageError(`${name} requires a value.`);
  }
  return { value: argv[index + 1], nextIndex: index + 1 };
}

function rejectInlineValue(name, inlineValue) {
  if (inlineValue !== undefined) usageError(`${name} does not accept a value.`);
}

function finiteNumber(value, name) {
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
    usageError(`${name} must be a non-negative number.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) usageError(`${name} must be a finite number.`);
  return parsed;
}

function positiveInteger(value, name) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) usageError(`${name} must be a whole number.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) usageError(`${name} must be a positive whole number.`);
  return parsed;
}

function parseSize(value) {
  const match = /^(\d+)[xX](\d+)$/.exec(value);
  if (!match) usageError("--size must use WIDTHxHEIGHT, for example 640x360.");
  return {
    width: positiveInteger(match[1], "size width"),
    height: positiveInteger(match[2], "size height"),
  };
}

function splitLongOption(token) {
  const equals = token.indexOf("=");
  if (equals === -1) return { name: token, inlineValue: undefined };
  return { name: token.slice(0, equals), inlineValue: token.slice(equals + 1) };
}

function setOnce(seen, key, displayName) {
  if (seen.has(key)) usageError(`${displayName} was provided more than once.`);
  seen.add(key);
}

function parseConvert(argv) {
  const seen = new Set();
  const positionals = [];
  const options = {
    command: "convert",
    start: 0,
    loop: true,
    json: false,
    progress: "auto",
    help: false,
    version: false,
  };
  let parseOptions = true;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (parseOptions && token === "--") {
      parseOptions = false;
      continue;
    }
    if (!parseOptions || token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    const { name, inlineValue } = splitLongOption(token);
    let value;
    switch (name) {
      case "-h":
      case "--help":
        rejectInlineValue(name, inlineValue);
        options.help = true;
        break;
      case "-V":
      case "--version":
        rejectInlineValue(name, inlineValue);
        options.version = true;
        break;
      case "--json":
        rejectInlineValue(name, inlineValue);
        setOnce(seen, "json", "--json");
        options.json = true;
        break;
      case "-f":
      case "--force":
        rejectInlineValue(name, inlineValue);
        setOnce(seen, "force", "--force");
        options.force = true;
        break;
      case "--loop":
        rejectInlineValue(name, inlineValue);
        if (seen.has("loop")) usageError("Use only one of --loop and --no-loop.");
        seen.add("loop");
        options.loop = true;
        break;
      case "--no-loop":
        rejectInlineValue(name, inlineValue);
        if (seen.has("loop")) usageError("Use only one of --loop and --no-loop.");
        seen.add("loop");
        options.loop = false;
        break;
      case "-o":
      case "--output": {
        setOnce(seen, "output", "--output");
        const consumed = optionValue(argv, index, name, inlineValue);
        options.outputPath = consumed.value;
        index = consumed.nextIndex;
        break;
      }
      case "--start": {
        setOnce(seen, "start", "--start");
        const consumed = optionValue(argv, index, name, inlineValue);
        options.start = parseTime(consumed.value);
        index = consumed.nextIndex;
        break;
      }
      case "--duration": {
        setOnce(seen, "duration", "--duration");
        const consumed = optionValue(argv, index, name, inlineValue);
        options.duration = parseTime(consumed.value);
        index = consumed.nextIndex;
        break;
      }
      case "--end": {
        setOnce(seen, "end", "--end");
        const consumed = optionValue(argv, index, name, inlineValue);
        options.end = parseTime(consumed.value);
        index = consumed.nextIndex;
        break;
      }
      case "--width": {
        setOnce(seen, "width", "--width");
        const consumed = optionValue(argv, index, name, inlineValue);
        options.width = positiveInteger(consumed.value, "--width");
        index = consumed.nextIndex;
        break;
      }
      case "--height": {
        setOnce(seen, "height", "--height");
        const consumed = optionValue(argv, index, name, inlineValue);
        options.height = positiveInteger(consumed.value, "--height");
        index = consumed.nextIndex;
        break;
      }
      case "--size": {
        setOnce(seen, "size", "--size");
        const consumed = optionValue(argv, index, name, inlineValue);
        options.size = parseSize(consumed.value);
        index = consumed.nextIndex;
        break;
      }
      case "--fps": {
        setOnce(seen, "fps", "--fps");
        const consumed = optionValue(argv, index, name, inlineValue);
        options.fps = finiteNumber(consumed.value, "--fps");
        index = consumed.nextIndex;
        break;
      }
      case "--colors": {
        setOnce(seen, "colors", "--colors");
        const consumed = optionValue(argv, index, name, inlineValue);
        options.colors = positiveInteger(consumed.value, "--colors");
        index = consumed.nextIndex;
        break;
      }
      case "--progress": {
        setOnce(seen, "progress", "--progress");
        const consumed = optionValue(argv, index, name, inlineValue);
        if (!["auto", "always", "never", "json"].includes(consumed.value)) {
          usageError("--progress must be auto, always, never, or json.");
        }
        options.progress = consumed.value;
        index = consumed.nextIndex;
        break;
      }
      default:
        usageError(`Unknown option: ${name}`);
    }
  }

  if (options.help || options.version) return options;
  if (positionals.length === 0) usageError("An input video is required.");
  if (positionals.length > 1) usageError(`Unexpected argument: ${positionals[1]}`);
  if (positionals[0] === "-") usageError("Reading video data from stdin is not supported; provide a file path.");
  options.inputPath = positionals[0];

  if (seen.has("duration") && seen.has("end")) usageError("Use only one of --duration and --end.");
  if (options.end !== undefined) {
    if (options.end <= options.start) usageError("--end must be later than --start.");
    options.duration = options.end - options.start;
  }
  const sizingCount = Number(seen.has("width")) + Number(seen.has("height")) + Number(seen.has("size"));
  if (sizingCount > 1) usageError("Use only one of --width, --height, and --size.");
  if (options.force && !options.outputPath) usageError("--force requires an explicit --output path.");

  return options;
}

function parseInspect(argv) {
  const positionals = [];
  let parseOptions = true;
  let json = false;
  let help = false;
  let version = false;
  for (const token of argv) {
    if (parseOptions && token === "--") {
      parseOptions = false;
    } else if (parseOptions && token.startsWith("-")) {
      if (token === "--json") {
        if (json) usageError("--json was provided more than once.");
        json = true;
      } else if (token === "-h" || token === "--help") {
        help = true;
      } else if (token === "-V" || token === "--version") {
        version = true;
      } else {
        usageError(`Unknown option: ${token}`);
      }
    } else {
      positionals.push(token);
    }
  }
  if (help || version) return { command: "inspect", help, version, json };
  if (positionals.length === 0) usageError("An input video is required for inspect.");
  if (positionals.length > 1) usageError(`Unexpected argument: ${positionals[1]}`);
  if (positionals[0] === "-") usageError("Reading video data from stdin is not supported; provide a file path.");
  return { command: "inspect", inputPath: positionals[0], json, help, version };
}

function parseMcp(argv) {
  if (argv.length === 0) return { command: "mcp", help: false, version: false, json: false };
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) {
    return { command: "mcp", help: true, version: false, json: false };
  }
  if (argv.length === 1 && (argv[0] === "-V" || argv[0] === "--version")) {
    return { command: "mcp", help: false, version: true, json: false };
  }
  usageError(`Unexpected argument for mcp: ${argv[0]}`);
}

export function parseCliArguments(argv) {
  if (!Array.isArray(argv)) usageError("Arguments must be an array.");
  if (argv.length === 0) return { command: "help", help: true, version: false, json: false };
  if (argv[0] === "help") {
    if (argv.length > 2) usageError(`Unexpected argument: ${argv[2]}`);
    const target = argv[1];
    if (target && !["convert", "inspect", "mcp"].includes(target)) usageError(`Unknown command: ${target}`);
    return { command: target || "help", help: true, version: false, json: false };
  }
  if (argv[0] === "inspect") return parseInspect(argv.slice(1));
  if (argv[0] === "mcp") return parseMcp(argv.slice(1));
  if (argv[0] === "convert") return parseConvert(argv.slice(1));
  return parseConvert(argv);
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function createProgressReporter(mode, stderr, jobId) {
  const effectiveMode = mode === "auto" ? (stderr.isTTY ? "tty" : "never") : mode;
  let lastKey = "";
  let openTtyLine = false;

  return {
    report(event) {
      const normalized = {
        schemaVersion: SCHEMA_VERSION,
        type: "progress",
        jobId,
        phase: event.phase,
        ratio: event.ratio,
        percent: event.percent,
        outTimeMs: event.outTimeMs,
      };
      const key = `${event.phase}:${event.percent}`;
      if (key === lastKey) return;
      lastKey = key;

      if (effectiveMode === "json") {
        stderr.write(jsonLine(normalized));
      } else if (effectiveMode === "always") {
        stderr.write(`${event.phase} ${event.percent}%\n`);
      } else if (effectiveMode === "tty") {
        const label = event.phase === "complete" ? "Complete" : event.phase === "starting" ? "Starting" : "Encoding";
        stderr.write(`\r${label} ${event.percent}%\u001b[K`);
        openTtyLine = event.phase !== "complete";
        if (event.phase === "complete") stderr.write("\n");
      }
    },
    finish() {
      if (effectiveMode === "tty" && openTtyLine) {
        stderr.write("\n");
        openTtyLine = false;
      }
    },
  };
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "INTERNAL_ERROR";
}

export function exitCodeForError(error) {
  if (Number.isInteger(error?.cliExitCode)) return error.cliExitCode;
  const code = errorCode(error);
  if (["INVALID_ARGUMENT", "FRAME_LIMIT_EXCEEDED"].includes(code)) return 2;
  if (["INPUT_NOT_FOUND", "INPUT_NOT_FILE", "NO_VIDEO_STREAM", "PROBE_FAILED", "ENOENT"].includes(code)) return 3;
  if (["OUTPUT_EXISTS", "OUTPUT_UNSAFE", "EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT"].includes(code)) return 4;
  if (code === "CANCELLED") return 130;
  return 1;
}

function serializableError(error) {
  const value = {
    code: errorCode(error),
    message: error instanceof Error ? error.message : String(error || "Unknown error"),
  };
  if (error?.details !== undefined) value.details = error.details;
  return value;
}

function emitError(error, json, stdout, stderr) {
  if (json) {
    stdout.write(jsonLine({
      schemaVersion: SCHEMA_VERSION,
      ok: false,
      error: serializableError(error),
    }));
  } else {
    const serialized = serializableError(error);
    stderr.write(`loopdrop: ${serialized.message}\n`);
  }
  return exitCodeForError(error);
}

function installSignalCancellation(processLike, controller, childRef) {
  let receivedSignal = null;
  let signalCount = 0;
  const handleSignal = (signal) => {
    receivedSignal = receivedSignal || signal;
    signalCount += 1;
    if (signalCount === 1) controller.abort();
    else childRef.current?.kill?.("SIGKILL");
  };
  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");
  processLike.on?.("SIGINT", onSigint);
  processLike.on?.("SIGTERM", onSigterm);
  return {
    receivedSignal: () => receivedSignal,
    dispose() {
      processLike.off?.("SIGINT", onSigint);
      processLike.off?.("SIGTERM", onSigterm);
    },
  };
}

async function resolvedConversionRequest(parsed, dependencies, cwd) {
  let duration = parsed.duration;
  if (duration === undefined) {
    const metadata = await dependencies.probeVideo(
      parsed.inputPath,
      dependencies.resolveBinary("ffprobe"),
    );
    const remaining = metadata.durationSeconds - parsed.start;
    if (!Number.isFinite(remaining) || remaining < 0.05) {
      throw new LoopdropError("INVALID_ARGUMENT", "The start time is at or beyond the end of the video.");
    }
    duration = Math.min(10, remaining);
  }

  const request = {
    inputPath: parsed.inputPath,
    outputDirectory: cwd,
    start: parsed.start,
    duration,
    fps: parsed.fps,
    colors: parsed.colors,
    loop: parsed.loop,
  };
  if (parsed.outputPath !== undefined) request.outputPath = parsed.outputPath;
  if (parsed.force !== undefined) request.overwrite = parsed.force;
  if (parsed.size) {
    request.width = parsed.size.width;
    request.height = parsed.size.height;
  } else if (parsed.width !== undefined) {
    request.width = parsed.width;
  } else if (parsed.height !== undefined) {
    request.height = parsed.height;
  }
  return request;
}

function conversionJson(jobId, result) {
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    command: "convert",
    jobId,
    inputPath: result.inputPath,
    outputPath: result.outputPath,
    sizeBytes: result.sizeBytes,
    durationMs: Math.round(result.durationSeconds * 1000),
    frames: result.frames,
    fps: result.fps,
    colors: result.colors,
    loop: result.loop,
    sizing: result.sizing,
    elapsedMs: result.elapsedMs,
  };
}

async function executeConvert(parsed, context) {
  const { stdout, stderr } = context.io;
  const jobId = context.dependencies.randomUUID();
  const reporter = createProgressReporter(parsed.progress, stderr, jobId);
  const controller = new AbortController();
  const childRef = { current: null };
  const cancellation = installSignalCancellation(context.processLike, controller, childRef);

  try {
    const request = await resolvedConversionRequest(parsed, context.dependencies, context.cwd());
    const result = await context.dependencies.convertToGif(request, {
      ffmpegPath: context.dependencies.resolveBinary("ffmpeg"),
      signal: controller.signal,
      onProgress: (event) => reporter.report(event),
      onProcess: (child) => { childRef.current = child; },
    });
    if (parsed.json) stdout.write(jsonLine(conversionJson(jobId, result)));
    else stdout.write(`${result.outputPath}\n`);
    return 0;
  } catch (error) {
    const signal = cancellation.receivedSignal();
    if (signal && errorCode(error) === "CANCELLED") {
      error.cliExitCode = signal === "SIGTERM" ? 143 : 130;
    }
    throw error;
  } finally {
    cancellation.dispose();
    reporter.finish();
  }
}

function inspectJson(metadata) {
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    command: "inspect",
    ...metadata,
    durationMs: Math.round(metadata.durationSeconds * 1000),
  };
}

async function executeInspect(parsed, context) {
  const metadata = await context.dependencies.probeVideo(
    parsed.inputPath,
    context.dependencies.resolveBinary("ffprobe"),
  );
  if (parsed.json) {
    context.io.stdout.write(jsonLine(inspectJson(metadata)));
  } else {
    const frameRate = Number.isFinite(metadata.frameRate) ? metadata.frameRate.toFixed(3).replace(/\.0+$/, "") : "unknown";
    context.io.stdout.write([
      `Input: ${metadata.inputPath}`,
      `Dimensions: ${metadata.width}x${metadata.height}`,
      `Duration: ${metadata.durationSeconds.toFixed(3)}s`,
      `Frame rate: ${frameRate}`,
      `Frames: ${metadata.frames ?? "unknown"}`,
      `Bytes: ${metadata.sizeBytes}`,
      "",
    ].join("\n"));
  }
  return 0;
}

async function defaultStartMcp() {
  const server = await import(new URL("../mcp/server.mjs", import.meta.url));
  if (typeof server.startStdio !== "function") {
    throw new Error("The loopdrop MCP server does not export startStdio().");
  }
  await server.startStdio();
}

function helpFor(command) {
  if (command === "inspect") return INSPECT_HELP;
  if (command === "mcp") return MCP_HELP;
  return GENERAL_HELP;
}

export async function runCli(argv, options = {}) {
  const io = {
    stdout: options.io?.stdout || process.stdout,
    stderr: options.io?.stderr || process.stderr,
  };
  const context = {
    io,
    cwd: options.cwd || (() => process.cwd()),
    processLike: options.processLike || process,
    dependencies: {
      convertToGif,
      probeVideo,
      resolveBinary,
      randomUUID,
      startMcp: defaultStartMcp,
      ...options.dependencies,
    },
  };
  let parsed;
  const requestedJson = argv.includes("--json");

  try {
    parsed = parseCliArguments(argv);
    if (parsed.version) {
      io.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (parsed.help) {
      io.stdout.write(helpFor(parsed.command));
      return 0;
    }
    if (parsed.command === "inspect") return await executeInspect(parsed, context);
    if (parsed.command === "mcp") {
      await context.dependencies.startMcp();
      return 0;
    }
    return await executeConvert(parsed, context);
  } catch (error) {
    return emitError(error, parsed?.json ?? requestedJson, io.stdout, io.stderr);
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}
