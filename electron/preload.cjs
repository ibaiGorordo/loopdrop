const { contextBridge, ipcRenderer, webUtils } = require("electron");

let bufferedMiniFile = null;
let bufferedSettingsOpen = false;
const miniFileCallbacks = new Set();
const settingsCallbacks = new Set();
ipcRenderer.on("mini:file", (_event, file) => {
  bufferedMiniFile = file;
  for (const callback of miniFileCallbacks) callback(file);
});
ipcRenderer.on("settings:open", () => {
  if (settingsCallbacks.size === 0) bufferedSettingsOpen = true;
  for (const callback of settingsCallbacks) callback();
});

contextBridge.exposeInMainWorld("loopdrop", {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  convert: (request) => ipcRenderer.invoke("conversion:start", request),
  cancel: (jobId) => ipcRenderer.invoke("conversion:cancel", jobId),
  showInFolder: (path) => ipcRenderer.invoke("file:show-in-folder", path),
  chooseVideo: () => ipcRenderer.invoke("video:choose"),
  inspectVideo: (inputPath) => ipcRenderer.invoke("video:inspect", inputPath),
  getMiniVideo: () => ipcRenderer.invoke("video:current-mini"),
  rememberMiniVideo: (inputPath) => ipcRenderer.invoke("video:remember-mini", inputPath),
  clearMiniVideo: () => ipcRenderer.invoke("video:clear-mini"),
  hideMini: () => ipcRenderer.invoke("window:hide-mini"),
  openFullApp: () => ipcRenderer.invoke("window:open-full"),
  onOpenSettings: (callback) => {
    settingsCallbacks.add(callback);
    if (bufferedSettingsOpen) {
      bufferedSettingsOpen = false;
      queueMicrotask(callback);
    }
    return () => settingsCallbacks.delete(callback);
  },
  onMiniFile: (callback) => {
    miniFileCallbacks.add(callback);
    if (bufferedMiniFile) queueMicrotask(() => callback(bufferedMiniFile));
    return () => miniFileCallbacks.delete(callback);
  },
  onProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("conversion:progress", listener);
    return () => ipcRenderer.removeListener("conversion:progress", listener);
  },
});
