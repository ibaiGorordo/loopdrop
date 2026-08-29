#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import binaries from "../core/binaries.cjs";
import converter from "../core/converter.cjs";

const { resolveBinary } = binaries;
const {
  LoopdropError,
  MAX_DIMENSION,
  MAX_DURATION_SECONDS,
  MAX_FRAMES,
  convertToGif: convertToGifCore,
  probeVideo: probeVideoCore,
} = converter;

const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0 && isAbsolute(value), {
    message: "Path must be absolute.",
  });

const convertInputSchema = z
  .object({
    inputPath: absolutePathSchema.describe("Absolute path to the local source video."),
    outputPath: absolutePathSchema
      .optional()
      .describe("Absolute destination path. A .gif extension is added when omitted; existing files are not overwritten."),
    outputDirectory: absolutePathSchema
      .optional()
      .describe("Absolute directory for an automatically named GIF. Existing files receive a numeric suffix."),
    start: z.number().finite().min(0).max(86400).default(0).describe("Start time in seconds."),
    duration: z
      .number()
      .finite()
      .min(0.05)
      .max(MAX_DURATION_SECONDS)
      .default(5)
      .describe(`Clip duration in seconds, up to ${MAX_DURATION_SECONDS}.`),
    fps: z.number().finite().min(1).max(30).default(12).describe("GIF frames per second."),
    width: z
      .number()
      .int()
      .min(2)
      .max(MAX_DIMENSION)
      .optional()
      .describe("Output width in pixels. Omit height to preserve aspect ratio."),
    height: z
      .number()
      .int()
      .min(2)
      .max(MAX_DIMENSION)
      .optional()
      .describe("Output height in pixels. Omit width to preserve aspect ratio."),
    colors: z.number().int().min(4).max(256).default(128).describe("Maximum GIF palette colors."),
    loop: z.boolean().default(true).describe("Whether the GIF repeats forever."),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outputPath !== undefined && value.outputDirectory !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["outputPath"],
        message: "Use outputPath or outputDirectory, not both.",
      });
    }
    if (Math.ceil(value.duration * value.fps) > MAX_FRAMES) {
      context.addIssue({
        code: "custom",
        path: ["duration"],
        message: `duration and fps must produce at most ${MAX_FRAMES} frames.`,
      });
    }
  });

const sizingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("width"), width: z.number().int().min(2).max(MAX_DIMENSION) }).strict(),
  z.object({ mode: z.literal("height"), height: z.number().int().min(2).max(MAX_DIMENSION) }).strict(),
  z
    .object({
      mode: z.literal("exact"),
      width: z.number().int().min(2).max(MAX_DIMENSION),
      height: z.number().int().min(2).max(MAX_DIMENSION),
    })
    .strict(),
]);

const convertOutputSchema = z
  .object({
    inputPath: absolutePathSchema,
    outputPath: absolutePathSchema,
    sizeBytes: z.number().int().nonnegative(),
    durationSeconds: z.number().finite().positive(),
    frames: z.number().int().positive(),
    fps: z.number().finite().positive(),
    colors: z.number().int().min(4).max(256),
    loop: z.boolean(),
    sizing: sizingSchema,
    elapsedMs: z.number().int().nonnegative(),
  })
  .strict();

const inspectInputSchema = z
  .object({
    inputPath: absolutePathSchema.describe("Absolute path to the local video file to inspect."),
  })
  .strict();

const inspectOutputSchema = z
  .object({
    inputPath: absolutePathSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationSeconds: z.number().finite().nonnegative(),
    frameRate: z.number().finite().nonnegative(),
    frames: z.number().int().nonnegative().nullable(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

function defaultDiagnostic(message) {
  console.error(`[loopdrop:mcp] ${message}`);
}

function reportDiagnostic(diagnostic, message) {
  try {
    diagnostic(message);
  } catch {
    // Diagnostics must never interfere with the protocol or a conversion.
  }
}

function errorDetails(error, fallbackCode) {
  const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : fallbackCode;
  const rawMessage = error instanceof Error ? error.message : String(error ?? "Unknown error");
  const message = rawMessage.length > 4000 ? `${rawMessage.slice(0, 3997)}...` : rawMessage;
  return { code, message };
}

function toolFailure(error, fallbackCode, diagnostic) {
  const details = errorDetails(error, fallbackCode);
  reportDiagnostic(diagnostic, `${details.code}: ${details.message}`);
  return {
    content: [{ type: "text", text: `${details.code}: ${details.message}` }],
    isError: true,
  };
}

function progressReporter(context, diagnostic) {
  const progressToken = context.mcpReq._meta?.progressToken;
  let lastProgress = -1;
  let pending = Promise.resolve();

  const onProgress = (update) => {
    if (progressToken === undefined) return;
    const numericProgress = Number(update?.percent);
    if (!Number.isFinite(numericProgress)) return;
    const progress = Math.min(100, Math.max(0, Math.round(numericProgress)));
    if (progress <= lastProgress) return;
    lastProgress = progress;

    const message = update?.phase === "complete"
      ? "GIF conversion complete"
      : update?.phase === "starting"
        ? "Starting GIF conversion"
        : `Encoding GIF (${progress}%)`;

    pending = pending
      .then(() => context.mcpReq.notify({
        method: "notifications/progress",
        params: { progressToken, progress, total: 100, message },
      }))
      .catch((error) => {
        const details = errorDetails(error, "PROGRESS_NOTIFICATION_FAILED");
        reportDiagnostic(diagnostic, `${details.code}: ${details.message}`);
      });
  };

  return { onProgress, flush: () => pending };
}

export function createServer(options = {}) {
  const convertToGif = options.convertToGif ?? convertToGifCore;
  const probeVideo = options.probeVideo ?? probeVideoCore;
  const diagnostic = options.diagnostic ?? defaultDiagnostic;
  const ffmpegPath = options.ffmpegPath ?? resolveBinary("ffmpeg", options);
  const ffprobePath = options.ffprobePath ?? resolveBinary("ffprobe", options);

  const server = new McpServer(
    {
      name: options.name ?? "loopdrop",
      version: options.version ?? "0.1.0",
    },
    {
      instructions:
        "Loopdrop inspects local video files and converts local clips to GIFs without network access. " +
        "Use inspect_video when media dimensions or duration are unknown. Existing output files are never overwritten.",
    },
  );

  server.registerTool(
    "inspect_video",
    {
      title: "Inspect video",
      description:
        "Read metadata from a local video file, including duration, dimensions, frame rate, frame count when available, and byte size.",
      inputSchema: inspectInputSchema,
      outputSchema: inspectOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ inputPath }, context) => {
      if (context.mcpReq.signal.aborted) {
        return toolFailure(new LoopdropError("CANCELLED", "Inspection cancelled."), "INSPECTION_FAILED", diagnostic);
      }

      try {
        const result = await probeVideo(inputPath, ffprobePath);
        if (context.mcpReq.signal.aborted) {
          return toolFailure(new LoopdropError("CANCELLED", "Inspection cancelled."), "INSPECTION_FAILED", diagnostic);
        }
        return {
          content: [
            {
              type: "text",
              text: [
                `Video: ${result.inputPath}`,
                `Dimensions: ${result.width}x${result.height}`,
                `Duration: ${result.durationSeconds} seconds`,
                `Frame rate: ${result.frameRate} fps`,
                `Size: ${result.sizeBytes} bytes`,
              ].join("\n"),
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return toolFailure(error, "INSPECTION_FAILED", diagnostic);
      }
    },
  );

  server.registerTool(
    "convert_video_to_gif",
    {
      title: "Convert video to GIF",
      description:
        `Convert a local video clip to a GIF entirely on this computer. Clips are limited to ${MAX_DURATION_SECONDS} seconds ` +
        `and ${MAX_FRAMES} frames. The tool creates a new file and never overwrites an existing output.`,
      inputSchema: convertInputSchema,
      outputSchema: convertOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (request, context) => {
      const progress = progressReporter(context, diagnostic);
      try {
        const result = await convertToGif(
          { ...request, overwrite: false },
          {
            ffmpegPath,
            signal: context.mcpReq.signal,
            onProgress: progress.onProgress,
          },
        );
        await progress.flush();
        return {
          content: [
            {
              type: "text",
              text: [
                `GIF created: ${result.outputPath}`,
                `Size: ${result.sizeBytes} bytes`,
                `Frames: ${result.frames} at ${result.fps} fps`,
              ].join("\n"),
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        await progress.flush();
        return toolFailure(error, "CONVERSION_FAILED", diagnostic);
      }
    },
  );

  return server;
}

export function startStdio(options = {}) {
  const { installSignalHandlers = true, onerror, ...serverOptions } = options;
  const diagnostic = serverOptions.diagnostic ?? defaultDiagnostic;
  const handle = serveStdio(() => createServer(serverOptions), {
    onerror: (error) => {
      const details = errorDetails(error, "PROTOCOL_ERROR");
      reportDiagnostic(diagnostic, `${details.code}: ${details.message}`);
      onerror?.(error);
    },
  });

  if (installSignalHandlers) {
    const shutdown = () => {
      void handle.close().catch((error) => {
        const details = errorDetails(error, "SHUTDOWN_FAILED");
        reportDiagnostic(diagnostic, `${details.code}: ${details.message}`);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  reportDiagnostic(diagnostic, "server listening on stdio");
  return handle;
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryUrl === import.meta.url) {
  try {
    startStdio();
  } catch (error) {
    const details = errorDetails(error, "STARTUP_FAILED");
    defaultDiagnostic(`${details.code}: ${details.message}`);
    process.exitCode = 1;
  }
}
