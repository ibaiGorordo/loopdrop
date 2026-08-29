const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerSaveBlocker,
  protocol,
  screen,
  shell,
  Tray,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const { randomUUID } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { stat } = require("node:fs/promises");
const { basename, extname, join, resolve } = require("node:path");
const { Readable } = require("node:stream");
const { resolveBinary } = require("../core/binaries.cjs");
const { convertToGif, LoopdropError, probeVideo } = require("../core/converter.cjs");
const { createUpdateManager } = require("./updater.cjs");

app.setName("Loopdrop");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "loopdrop-media",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

const activeJobs = new Map();
const activeNotifications = new Set();
const approvedOutputs = new Set();
const jobProgress = new Map();
const mediaFiles = new Map();
const pendingOpenFiles = [];
const startInMiniMode = process.argv.includes("--mini");
const releasesUrl = "https://github.com/ibaiGorordo/loopdrop/releases";
const videoExtensions = new Set([
  ".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".ogv", ".webm", ".wmv",
]);

let isQuitting = false;
let updateInstallRequested = false;
let lastOutputPath = null;
let mainWindow = null;
let miniReady = false;
let miniWindow = null;
let currentMiniFile = null;
let pendingMiniFile = null;
let suspensionBlocker = null;
let tray = null;
let updateManager = null;

function ffmpegPath() {
  return resolveBinary("ffmpeg", { resourcesPath: app.isPackaged ? process.resourcesPath : undefined });
}

function ffprobePath() {
  return resolveBinary("ffprobe", { resourcesPath: app.isPackaged ? process.resourcesPath : undefined });
}

function keepConversionsRunning() {
  if (suspensionBlocker === null || !powerSaveBlocker.isStarted(suspensionBlocker)) {
    suspensionBlocker = powerSaveBlocker.start("prevent-app-suspension");
  }
}

function releaseSuspensionBlocker() {
  if (activeJobs.size === 0 && suspensionBlocker !== null && powerSaveBlocker.isStarted(suspensionBlocker)) {
    powerSaveBlocker.stop(suspensionBlocker);
    suspensionBlocker = null;
  }
}

function registerMedia(filePath) {
  const token = randomUUID();
  mediaFiles.set(token, filePath);
  while (mediaFiles.size > 75) mediaFiles.delete(mediaFiles.keys().next().value);
  return `loopdrop-media://file/${token}`;
}

function registerOutput(outputPath) {
  approvedOutputs.add(outputPath);
  lastOutputPath = outputPath;
  return registerMedia(outputPath);
}

function mediaType(filePath) {
  return {
    ".avi": "video/x-msvideo",
    ".gif": "image/gif",
    ".m4v": "video/x-m4v",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpeg",
    ".ogv": "video/ogg",
    ".webm": "video/webm",
    ".wmv": "video/x-ms-wmv",
  }[extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function mediaResponse(request, filePath) {
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const total = fileStats.size;
  const range = request.headers.get("range");
  let start = 0;
  let end = Math.max(0, total - 1);
  let status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
    if (!match) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Math.min(Number(match[2]), total - 1);
    if (!match[1] && match[2]) {
      const suffixLength = Math.min(Number(match[2]), total);
      start = total - suffixLength;
      end = total - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= total) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    status = 206;
  }
  const length = Math.max(0, end - start + 1);
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": String(length),
    "Content-Type": mediaType(filePath),
  };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
  if (request.method === "HEAD") return new Response(null, { status, headers });
  const stream = Readable.toWeb(createReadStream(filePath, { start, end }));
  return new Response(stream, { status, headers });
}

function normalizedJobId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) {
    throw new LoopdropError("INVALID_ARGUMENT", "A valid job identifier is required.");
  }
  return value;
}

function currentProgress() {
  const values = [...jobProgress.values()];
  return values.length > 0 ? Math.max(...values) : null;
}

function updateTray() {
  if (!tray) return;
  const percent = currentProgress();
  const busy = activeJobs.size > 0;
  tray.setToolTip(busy
    ? `Loopdrop — converting${percent === null ? "…" : ` · ${percent}%`}`
    : "Loopdrop — click for mini converter · drop a video");
  if (process.platform === "darwin") tray.setTitle(busy && percent !== null ? ` ${percent}%` : "");
}

async function runConversion(request, { jobId, onProgress } = {}) {
  const id = normalizedJobId(jobId || randomUUID());
  if (isQuitting || updateInstallRequested) {
    throw new LoopdropError("UPDATE_INSTALLING", "Loopdrop is restarting to install an update. Try again after it reopens.");
  }
  if (activeJobs.has(id)) throw new LoopdropError("JOB_EXISTS", "That conversion is already running.");

  const controller = new AbortController();
  activeJobs.set(id, controller);
  jobProgress.set(id, 0);
  keepConversionsRunning();
  updateTray();
  try {
    const converted = await convertToGif(
      {
        ...request,
        outputDirectory: request.outputDirectory || app.getPath("downloads"),
      },
      {
        ffmpegPath: ffmpegPath(),
        signal: controller.signal,
        onProgress: (progress) => {
          jobProgress.set(id, progress.percent);
          updateTray();
          onProgress?.(progress);
        },
      },
    );
    return {
      ...converted,
      outputName: basename(converted.outputPath),
      previewUrl: registerOutput(converted.outputPath),
      size: converted.sizeBytes,
    };
  } finally {
    activeJobs.delete(id);
    jobProgress.delete(id);
    releaseSuspensionBlocker();
    updateTray();
    if (activeJobs.size === 0) void updateManager?.conversionFinished();
  }
}

function sendRendererProgress(event, jobId, progress) {
  if (event.sender.isDestroyed()) return;
  const message = progress.phase === "complete"
    ? "GIF saved"
    : progress.phase === "starting"
      ? "Starting native converter — safe to switch apps"
      : `Converting in background · ${progress.percent}%`;
  event.sender.send("conversion:progress", { jobId, percent: progress.percent, message });
}

async function convertFromRenderer(event, rawRequest) {
  const jobId = normalizedJobId(rawRequest?.jobId);
  const fromMini = miniWindow && !miniWindow.isDestroyed() && event.sender === miniWindow.webContents;
  const result = await runConversion(rawRequest, {
    jobId,
    onProgress: (progress) => sendRendererProgress(event, jobId, progress),
  });
  if (fromMini) showNotification("GIF ready", `${result.outputName} was saved to Downloads.`, result.outputPath);
  return result;
}

function showNotification(title, body, outputPath) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: false });
  activeNotifications.add(notification);
  if (outputPath) notification.on("click", () => shell.showItemInFolder(outputPath));
  notification.on("close", () => activeNotifications.delete(notification));
  notification.show();
}

function acceptsVideo(filePath) {
  return typeof filePath === "string" && videoExtensions.has(extname(filePath).toLowerCase());
}

async function mediaPayload(filePath) {
  if (!acceptsVideo(filePath)) {
    throw new LoopdropError("INVALID_MEDIA", "Choose an MP4, MOV, M4V, WebM, or another common video file.");
  }
  const absolutePath = resolve(filePath);
  const fileStats = await stat(absolutePath);
  if (!fileStats.isFile()) throw new LoopdropError("INPUT_NOT_FILE", "The selected video is not a regular file.");
  const metadata = await probeVideo(absolutePath, ffprobePath());
  if (
    !Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds < 0.05 ||
    !Number.isFinite(metadata.width) || metadata.width < 1 ||
    !Number.isFinite(metadata.height) || metadata.height < 1
  ) {
    throw new LoopdropError("INVALID_MEDIA", "This video does not contain readable duration and dimensions.");
  }
  return {
    inputPath: absolutePath,
    name: basename(absolutePath),
    size: fileStats.size,
    previewUrl: registerMedia(absolutePath),
    duration: metadata.durationSeconds,
    width: metadata.width,
    height: metadata.height,
  };
}

function trayIconPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "tray", "trayTemplate.png")
    : join(__dirname, "..", "build-resources", "trayTemplate.png");
}

function loadRenderer(window, query) {
  if (process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL);
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
    return window.loadURL(url.toString());
  }
  return window.loadFile(join(__dirname, "..", "dist", "index.html"), { query });
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 860,
    minHeight: 680,
    title: "Loopdrop",
    backgroundColor: "#f5f1e8",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    if (!isQuitting) app.dock?.hide();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void loadRenderer(window);
  return window;
}

function showMainWindow() {
  miniWindow?.hide();
  app.dock?.show();
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

function openSettingsWindow() {
  const window = showMainWindow();
  const send = () => {
    if (!window.isDestroyed()) window.webContents.send("settings:open");
  };
  if (window.webContents.isLoadingMainFrame()) window.webContents.once("did-finish-load", send);
  else send();
}

function updateDialogParent() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return mainWindow;
  if (miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible()) return miniWindow;
  return null;
}

async function runUpdateCommand() {
  try {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      await shell.openExternal(releasesUrl);
      return;
    }
    await updateManager?.checkNow();
  } catch (error) {
    showNotification("Loopdrop updates", error instanceof Error ? error.message : "The update action could not be completed.");
  }
}

function updateMenuItem() {
  const state = updateManager?.getState();
  return {
    label: updateManager?.menuLabel() || (process.platform === "linux" ? "View Loopdrop Updates…" : "Check for Updates…"),
    enabled: state?.phase !== "installing",
    click: () => void runUpdateCommand(),
  };
}

function createApplicationMenu() {
  const settingsItem = {
    label: "Settings…",
    accelerator: "CommandOrControl+,",
    click: openSettingsWindow,
  };
  const editMenu = {
    label: "Edit",
    submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" },
      ...(process.platform === "darwin" ? [{ role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" }, { type: "separator" }, { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] }] : [{ role: "delete" }, { type: "separator" }, { role: "selectAll" }]),
    ],
  };
  const windowMenu = {
    label: "Window",
    submenu: [{ role: "minimize" }, { role: "zoom" }, ...(process.platform === "darwin" ? [{ type: "separator" }, { role: "front" }] : [{ role: "close" }])],
  };
  const template = process.platform === "darwin"
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about" }, { type: "separator" }, updateMenuItem(), settingsItem, { type: "separator" },
            { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" },
          ],
        },
        editMenu,
        windowMenu,
      ]
    : [
        { label: "File", submenu: [settingsItem, { type: "separator" }, { role: "quit" }] },
        editMenu,
        windowMenu,
        { label: "Help", submenu: [updateMenuItem()] },
      ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function positionMiniWindow() {
  if (!tray || !miniWindow) return;
  const trayBounds = tray.getBounds();
  const windowBounds = miniWindow.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height / 2),
  });
  const workArea = display.workArea;
  const centeredX = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2);
  const x = Math.min(Math.max(centeredX, workArea.x + 8), workArea.x + workArea.width - windowBounds.width - 8);
  const trayIsAbove = trayBounds.y < display.bounds.y + display.bounds.height / 2;
  const preferredY = trayIsAbove
    ? trayBounds.y + trayBounds.height + 8
    : trayBounds.y - windowBounds.height - 8;
  const y = Math.min(Math.max(preferredY, workArea.y + 4), workArea.y + workArea.height - windowBounds.height - 8);
  miniWindow.setPosition(x, y, false);
}

function sendPendingMiniFile() {
  if (!miniReady || !pendingMiniFile || !miniWindow || miniWindow.isDestroyed()) return;
  miniWindow.webContents.send("mini:file", pendingMiniFile);
  pendingMiniFile = null;
}

function createMiniWindow() {
  const window = new BrowserWindow({
    width: 410,
    height: 176,
    minWidth: 410,
    minHeight: 176,
    maxWidth: 410,
    maxHeight: 176,
    title: "Loopdrop Mini",
    backgroundColor: "#f7f3eb",
    alwaysOnTop: true,
    frame: false,
    fullscreenable: false,
    hasShadow: true,
    maximizable: false,
    minimizable: false,
    resizable: false,
    roundedCorners: true,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  miniWindow = window;
  miniReady = false;
  window.setAlwaysOnTop(true, "pop-up-menu");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.once("did-finish-load", () => {
    miniReady = true;
    sendPendingMiniFile();
  });
  window.on("close", (event) => {
    if (!isQuitting && !updateInstallRequested) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (miniWindow === window) miniWindow = null;
    miniReady = false;
  });
  void loadRenderer(window, { mode: "mini" });
  return window;
}

function showMiniWindow() {
  const window = miniWindow && !miniWindow.isDestroyed() ? miniWindow : createMiniWindow();
  positionMiniWindow();
  window.show();
  window.focus();
  sendPendingMiniFile();
}

function toggleMiniWindow() {
  if (miniWindow?.isVisible()) miniWindow.hide();
  else showMiniWindow();
}

async function showMiniForFile(filePath) {
  try {
    currentMiniFile = await mediaPayload(filePath);
    pendingMiniFile = currentMiniFile;
    showMiniWindow();
  } catch (error) {
    showNotification("Loopdrop needs a video", error instanceof Error ? error.message : "That file could not be opened.");
  }
}

async function chooseVideo(parentWindow) {
  try {
    const options = {
      title: "Choose a video to convert",
      properties: ["openFile"],
      filters: [{ name: "Video files", extensions: [...videoExtensions].map((value) => value.slice(1)) }],
    };
    const result = parentWindow
      ? await dialog.showOpenDialog(parentWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return await mediaPayload(result.filePaths[0]);
  } finally {
    if (parentWindow && !parentWindow.isDestroyed()) parentWindow.focus();
  }
}

async function chooseVideoFromTray() {
  const payload = await chooseVideo(miniWindow);
  if (!payload) return;
  pendingMiniFile = payload;
  showMiniWindow();
}

function trayMenu() {
  const busy = activeJobs.size > 0;
  const percent = currentProgress();
  const launchAtLogin = app.isPackaged && app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: busy ? `Converting${percent === null ? "…" : ` — ${percent}%`}` : "Loopdrop Mini", enabled: false },
    { type: "separator" },
    { label: "Show mini converter", click: showMiniWindow },
    { label: "Choose a video…", click: () => void chooseVideoFromTray() },
    { label: "Open full app", click: showMainWindow },
    { label: "Settings…", accelerator: "CommandOrControl+,", click: openSettingsWindow },
    updateMenuItem(),
    { label: "Show last GIF", enabled: Boolean(lastOutputPath), click: () => shell.showItemInFolder(lastOutputPath) },
    { type: "separator" },
    {
      label: "Launch at login",
      type: "checkbox",
      checked: launchAtLogin,
      enabled: app.isPackaged,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    { label: "Quit Loopdrop", click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function createTray() {
  const image = nativeImage.createFromPath(trayIconPath());
  image.setTemplateImage(process.platform === "darwin");
  tray = new Tray(image);
  updateTray();
  tray.on("click", toggleMiniWindow);
  tray.on("right-click", () => tray.popUpContextMenu(trayMenu()));
  tray.on("drag-enter", () => tray?.setToolTip("Loopdrop — release to configure this video"));
  tray.on("drag-leave", updateTray);
  tray.on("drag-end", updateTray);
  tray.on("drop-files", (event, files) => {
    event.preventDefault();
    if (files.length > 0) void showMiniForFile(files[0]);
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const requestedVideo = argv.find(acceptsVideo);
    const showRequestedSurface = () => {
      if (requestedVideo) void showMiniForFile(requestedVideo);
      else if (argv.includes("--mini")) showMiniWindow();
      else showMainWindow();
    };
    if (app.isReady()) showRequestedSurface();
    else void app.whenReady().then(showRequestedSurface);
  });
}

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) void showMiniForFile(filePath);
  else pendingOpenFiles.push(filePath);
});

app.whenReady().then(() => {
  protocol.handle("loopdrop-media", (request) => {
    const token = new URL(request.url).pathname.slice(1);
    const file = mediaFiles.get(token);
    return file ? mediaResponse(request, file) : new Response("Not found", { status: 404 });
  });

  ipcMain.handle("conversion:start", convertFromRenderer);
  ipcMain.handle("conversion:cancel", (_event, jobId) => {
    const controller = activeJobs.get(jobId);
    if (!controller) return false;
    controller.abort();
    return true;
  });
  ipcMain.handle("file:show-in-folder", (_event, outputPath) => {
    if (!approvedOutputs.has(outputPath)) throw new Error("That file is not a Loopdrop output.");
    shell.showItemInFolder(outputPath);
  });
  ipcMain.handle("video:choose", async (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const payload = await chooseVideo(senderWindow);
    if (payload && senderWindow === miniWindow) currentMiniFile = payload;
    return payload;
  });
  ipcMain.handle("video:inspect", (_event, inputPath) => mediaPayload(inputPath));
  ipcMain.handle("video:current-mini", (event) => {
    if (!miniWindow || event.sender !== miniWindow.webContents) return null;
    return currentMiniFile;
  });
  ipcMain.handle("video:remember-mini", async (event, inputPath) => {
    if (!miniWindow || event.sender !== miniWindow.webContents) return null;
    currentMiniFile = await mediaPayload(inputPath);
    return currentMiniFile;
  });
  ipcMain.handle("video:clear-mini", (event) => {
    if (!miniWindow || event.sender !== miniWindow.webContents) return false;
    currentMiniFile = null;
    pendingMiniFile = null;
    return true;
  });
  ipcMain.handle("window:hide-mini", () => miniWindow?.hide());
  ipcMain.handle("window:open-full", () => showMainWindow());

  updateManager = createUpdateManager({
    app,
    autoUpdater,
    dialog,
    getDialogParent: updateDialogParent,
    hasActiveJobs: () => activeJobs.size > 0,
    setInstallRequested: (requested) => { updateInstallRequested = requested; },
    notify: showNotification,
    onStateChange: createApplicationMenu,
  });
  createApplicationMenu();
  createTray();
  const openedAtLogin = app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin;
  if (openedAtLogin || startInMiniMode) app.dock?.hide();
  else createMainWindow();
  if (startInMiniMode) showMiniWindow();
  const commandLineVideo = process.argv.find(acceptsVideo);
  if (pendingOpenFiles.length > 0) void showMiniForFile(pendingOpenFiles.shift());
  else if (commandLineVideo) void showMiniForFile(commandLineVideo);
  app.on("activate", showMainWindow);

  updateManager.start();
});

app.on("window-all-closed", () => {
  // The menu-bar mini converter remains available without the full window.
});

app.on("before-quit", () => {
  isQuitting = true;
  updateManager?.stop();
  for (const controller of activeJobs.values()) controller.abort();
});
