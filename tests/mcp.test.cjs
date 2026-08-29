const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const projectRoot = resolve(__dirname, "..");
const serverPath = resolve(projectRoot, "mcp", "server.mjs");
const sourcePath = resolve(projectRoot, "test-fixtures", "source.mp4");
const outputDirectory = resolve(projectRoot, "test-output");
const outputPath = resolve(outputDirectory, "source.gif");

async function sdk() {
  const [clientModule, stdioModule, serverModule] = await Promise.all([
    import("@modelcontextprotocol/client"),
    import("@modelcontextprotocol/client/stdio"),
    import(pathToFileURL(serverPath).href),
  ]);
  return { ...clientModule, ...stdioModule, ...serverModule };
}

async function inMemoryHarness(t, serverOptions) {
  const { Client, InMemoryTransport, createServer } = await sdk();
  const server = createServer({ diagnostic: () => {}, ...serverOptions });
  const client = new Client({ name: "loopdrop-mcp-tests", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  return { client, server };
}

test("MCP tools expose validated schemas and structured local-media results", async (t) => {
  let receivedSignal;
  const progressUpdates = [];
  const conversionResult = {
    inputPath: sourcePath,
    outputPath,
    sizeBytes: 4321,
    durationSeconds: 2,
    frames: 16,
    fps: 8,
    colors: 64,
    loop: true,
    sizing: { mode: "width", width: 320 },
    elapsedMs: 75,
  };
  const inspectionResult = {
    inputPath: sourcePath,
    width: 1920,
    height: 1080,
    durationSeconds: 12.5,
    frameRate: 24,
    frames: 300,
    sizeBytes: 987654,
  };

  const { client } = await inMemoryHarness(t, {
    ffmpegPath: resolve(projectRoot, "fake", "ffmpeg"),
    ffprobePath: resolve(projectRoot, "fake", "ffprobe"),
    convertToGif: async (request, options) => {
      assert.equal(request.inputPath, sourcePath);
      assert.equal(request.outputDirectory, outputDirectory);
      assert.equal(request.duration, 2);
      assert.equal(request.fps, 8);
      assert.equal(request.overwrite, false);
      receivedSignal = options.signal;
      options.onProgress({ phase: "starting", percent: 0 });
      options.onProgress({ phase: "encoding", percent: 40 });
      options.onProgress({ phase: "encoding", percent: 40 });
      options.onProgress({ phase: "complete", percent: 100 });
      return conversionResult;
    },
    probeVideo: async (inputPath, ffprobePath) => {
      assert.equal(inputPath, sourcePath);
      assert.ok(ffprobePath.endsWith("ffprobe"));
      return inspectionResult;
    },
  });

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["convert_video_to_gif", "inspect_video"],
  );
  const conversionTool = listed.tools.find((tool) => tool.name === "convert_video_to_gif");
  const inspectionTool = listed.tools.find((tool) => tool.name === "inspect_video");
  assert.equal(conversionTool.annotations.destructiveHint, false);
  assert.equal(conversionTool.annotations.openWorldHint, false);
  assert.equal(inspectionTool.annotations.readOnlyHint, true);
  assert.equal(conversionTool.inputSchema.type, "object");
  assert.equal(conversionTool.outputSchema.type, "object");

  const inspected = await client.callTool({
    name: "inspect_video",
    arguments: { inputPath: sourcePath },
  });
  assert.equal(inspected.isError, undefined);
  assert.deepEqual(inspected.structuredContent, inspectionResult);

  const converted = await client.callTool(
    {
      name: "convert_video_to_gif",
      arguments: {
        inputPath: sourcePath,
        outputDirectory,
        duration: 2,
        fps: 8,
        width: 320,
        colors: 64,
      },
    },
    {
      onprogress: (update) => progressUpdates.push(update),
      resetTimeoutOnProgress: true,
    },
  );

  assert.equal(converted.isError, undefined);
  assert.deepEqual(converted.structuredContent, conversionResult);
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.deepEqual(progressUpdates.map((update) => update.progress), [0, 40, 100]);
  assert.ok(progressUpdates.every((update) => update.total === 100));
});

test("MCP rejects relative paths and unsafe output combinations before calling core", async (t) => {
  let calls = 0;
  const { client } = await inMemoryHarness(t, {
    convertToGif: async () => {
      calls += 1;
      throw new Error("should not run");
    },
    probeVideo: async () => {
      calls += 1;
      throw new Error("should not run");
    },
  });

  const relativeInspection = await client.callTool({
    name: "inspect_video",
    arguments: { inputPath: "relative/video.mp4" },
  });
  assert.equal(relativeInspection.isError, true);
  assert.match(relativeInspection.content[0].text, /absolute/i);

  const conflictingOutputs = await client.callTool({
    name: "convert_video_to_gif",
    arguments: {
      inputPath: sourcePath,
      outputPath,
      outputDirectory,
    },
  });
  assert.equal(conflictingOutputs.isError, true);
  assert.match(conflictingOutputs.content[0].text, /outputPath or outputDirectory/i);

  const tooManyFrames = await client.callTool({
    name: "convert_video_to_gif",
    arguments: { inputPath: sourcePath, duration: 60, fps: 30 },
  });
  assert.equal(tooManyFrames.isError, true);
  assert.match(tooManyFrames.content[0].text, /at most 300 frames/i);
  assert.equal(calls, 0);
});

test("MCP cancellation reaches the shared converter AbortSignal", { timeout: 5000 }, async (t) => {
  let markEntered;
  const entered = new Promise((resolvePromise) => { markEntered = resolvePromise; });
  let markAborted;
  const aborted = new Promise((resolvePromise) => { markAborted = resolvePromise; });
  const { client } = await inMemoryHarness(t, {
    convertToGif: async (_request, { signal }) => {
      markEntered();
      await new Promise((_, rejectPromise) => {
        const onAbort = () => {
          markAborted();
          const error = new Error("Conversion cancelled.");
          error.code = "CANCELLED";
          rejectPromise(error);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  });
  const controller = new AbortController();
  const call = client.callTool(
    {
      name: "convert_video_to_gif",
      arguments: { inputPath: sourcePath },
    },
    { signal: controller.signal },
  );

  await entered;
  controller.abort();
  await assert.rejects(call, /aborted/i);
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("Server did not receive cancellation.")), 1000);
    aborted.then(() => {
      clearTimeout(timer);
      resolvePromise();
    }, rejectPromise);
  });
});

test("executable stdio server negotiates modern MCP without corrupting stdout", { timeout: 15000 }, async (t) => {
  const { Client, StdioClientTransport } = await sdk();
  const client = new Client(
    { name: "loopdrop-stdio-tests", version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: projectRoot,
    stderr: "pipe",
  });

  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), "modern");

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["convert_video_to_gif", "inspect_video"],
  );

  const rejected = await client.callTool({
    name: "inspect_video",
    arguments: { inputPath: "not-an-absolute-path.mp4" },
  });
  assert.equal(rejected.isError, true);
});
