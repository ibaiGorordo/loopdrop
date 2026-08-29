"use strict";

const DEFAULT_INITIAL_DELAY_MS = 10_000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1_000;

function createUpdateManager({
  app,
  autoUpdater,
  dialog,
  getDialogParent = () => null,
  hasActiveJobs = () => false,
  setInstallRequested = () => {},
  notify = () => {},
  onStateChange = () => {},
  logger = console,
  platform = process.platform,
  timers = globalThis,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
}) {
  const supportsSelfUpdate = platform === "darwin" || platform === "win32";
  let phase = "idle";
  let version = null;
  let interactive = false;
  let currentOperation = null;
  let deferredPrompt = false;
  let promptOperation = null;
  let installRequested = false;
  let started = false;
  let disposed = false;
  let lifecycleGeneration = 0;
  let failureGeneration = 0;
  let initialTimer = null;
  let intervalTimer = null;
  const listeners = [];

  function snapshot() {
    return { phase, version, supportsSelfUpdate, installRequested };
  }

  function setState(nextPhase, nextVersion = version) {
    const changed = phase !== nextPhase || version !== nextVersion;
    phase = nextPhase;
    version = nextVersion || null;
    if (changed) onStateChange(snapshot());
  }

  function updateVersion(info) {
    return typeof info?.version === "string" && info.version.trim() ? info.version.trim() : version;
  }

  function isLive(generation) {
    return started && !disposed && lifecycleGeneration === generation;
  }

  function setInstallGuard(requested) {
    if (installRequested === requested) return;
    installRequested = requested;
    setInstallRequested(requested);
  }

  function validParent() {
    const parent = getDialogParent();
    if (!parent) return null;
    return typeof parent.isDestroyed !== "function" || !parent.isDestroyed() ? parent : null;
  }

  function showMessageBox(options) {
    const parent = validParent();
    return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  }

  function logFailure(error) {
    const message = error instanceof Error ? error.message : String(error || "Unknown update error");
    logger.warn?.(`Loopdrop update check failed: ${message}`);
  }

  function showManualFailure() {
    return showMessageBox({
      type: "warning",
      buttons: ["OK"],
      defaultId: 0,
      title: "Loopdrop Updates",
      message: "Loopdrop couldn’t check for updates.",
      detail: "Check your internet connection and try again. Updates become available after a public GitHub release is published.",
    });
  }

  function showInstallFailure() {
    return showMessageBox({
      type: "warning",
      buttons: ["OK"],
      defaultId: 0,
      title: "Loopdrop Updates",
      message: "Loopdrop couldn’t install the update.",
      detail: "Loopdrop will stay open. Try Check for Updates again, or install the latest release manually.",
    });
  }

  function handleFailure(error, generation = lifecycleGeneration) {
    if (!isLive(generation)) return;
    failureGeneration += 1;
    const failedInstall = installRequested;
    const shouldShow = interactive || failedInstall;
    interactive = false;
    deferredPrompt = false;
    setInstallGuard(false);
    setState("idle", null);
    logFailure(error);
    if (shouldShow) void (failedInstall ? showInstallFailure() : showManualFailure()).catch(logFailure);
  }

  async function promptToInstall({ requestedByUser = false } = {}) {
    if (promptOperation) return promptOperation;
    if (!started || phase !== "ready" || installRequested) return false;
    const generation = lifecycleGeneration;
    let operation;
    operation = (async () => {
      if (hasActiveJobs()) {
        deferredPrompt = true;
        if (requestedByUser) {
          await showMessageBox({
            type: "info",
            buttons: ["OK"],
            defaultId: 0,
            title: "Loopdrop Updates",
            message: `Loopdrop ${version || "update"} is ready to install.`,
            detail: "Finish the current GIF conversion first. Loopdrop will ask to restart when it is safe.",
          });
          if (!isLive(generation)) return false;
        } else {
          notify("Loopdrop update ready", "It will be ready to install after the current GIF conversion finishes.");
        }
        return false;
      }

      deferredPrompt = false;
      const result = await showMessageBox({
        type: "info",
        buttons: ["Restart and Install", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: "Loopdrop Updates",
        message: `Loopdrop ${version || "update"} is ready to install.`,
        detail: "Restart Loopdrop now to finish the update. Your files and settings will stay in place.",
      });
      if (!isLive(generation) || result.response !== 0 || phase !== "ready") return false;
      if (hasActiveJobs()) {
        deferredPrompt = true;
        notify("Loopdrop update waiting", "The update will wait until the current GIF conversion finishes.");
        return false;
      }

      setInstallGuard(true);
      setState("installing", version);
      const failureAtInstall = failureGeneration;
      try {
        autoUpdater.quitAndInstall(false, true);
        if (
          !isLive(generation) || failureGeneration !== failureAtInstall ||
          phase !== "installing" || !installRequested
        ) return false;
        return true;
      } catch (error) {
        if (!isLive(generation) || failureGeneration !== failureAtInstall) return false;
        setInstallGuard(false);
        setState("ready", version);
        await showInstallFailure().catch(logFailure);
        throw error;
      }
    })().finally(() => {
      if (promptOperation !== operation) return;
      promptOperation = null;
      if (isLive(generation) && deferredPrompt && phase === "ready" && !hasActiveJobs()) {
        queueMicrotask(() => {
          if (isLive(generation) && !promptOperation) void promptToInstall().catch(logFailure);
        });
      }
    });
    promptOperation = operation;
    return operation;
  }

  function handleChecking() {
    setState("checking", null);
  }

  function handleUpdateAvailable(info) {
    setState("downloading", updateVersion(info));
    if (interactive) {
      notify(
        "Loopdrop update found",
        `Version ${version || "the latest version"} is downloading in the background.`,
      );
    }
  }

  function handleUpdateNotAvailable(info) {
    const shouldShow = interactive;
    interactive = false;
    setState("idle", updateVersion(info));
    if (shouldShow) {
      void showMessageBox({
        type: "info",
        buttons: ["OK"],
        defaultId: 0,
        title: "Loopdrop Updates",
        message: "Loopdrop is up to date.",
        detail: `You’re running version ${app.getVersion()}.`,
      }).catch(logFailure);
    }
  }

  function handleUpdateDownloaded(info) {
    interactive = false;
    setState("ready", updateVersion(info));
    void promptToInstall().catch(logFailure);
  }

  function listen(eventName, listener) {
    autoUpdater.on(eventName, listener);
    listeners.push([eventName, listener]);
  }

  function start() {
    if (started || disposed || !app.isPackaged || !supportsSelfUpdate) return false;
    started = true;
    lifecycleGeneration += 1;
    const generation = lifecycleGeneration;
    autoUpdater.logger = null;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.disableWebInstaller = true;

    listen("checking-for-update", () => { if (isLive(generation)) handleChecking(); });
    listen("update-available", (info) => { if (isLive(generation)) handleUpdateAvailable(info); });
    listen("update-not-available", (info) => { if (isLive(generation)) handleUpdateNotAvailable(info); });
    listen("update-downloaded", (info) => { if (isLive(generation)) handleUpdateDownloaded(info); });
    listen("error", (error) => handleFailure(error, generation));
    listen("update-cancelled", () => handleFailure(new Error("The update download was cancelled."), generation));

    initialTimer = timers.setTimeout(() => void check(), initialDelayMs);
    initialTimer?.unref?.();
    intervalTimer = timers.setInterval(() => void check(), intervalMs);
    intervalTimer?.unref?.();
    return true;
  }

  function stop() {
    if (disposed) return;
    disposed = true;
    if (initialTimer !== null) timers.clearTimeout(initialTimer);
    if (intervalTimer !== null) timers.clearInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
    for (const [eventName, listener] of listeners.splice(0)) {
      autoUpdater.removeListener(eventName, listener);
    }
    started = false;
    lifecycleGeneration += 1;
    currentOperation = null;
    promptOperation = null;
    interactive = false;
    deferredPrompt = false;
    phase = "idle";
    version = null;
    setInstallGuard(false);
  }

  function check({ manual = false } = {}) {
    if (disposed) return Promise.resolve(false);
    if (!app.isPackaged) {
      if (manual) {
        return showMessageBox({
          type: "info",
          buttons: ["OK"],
          defaultId: 0,
          title: "Loopdrop Updates",
          message: "Update checks are available in installed builds.",
          detail: `This development build is version ${app.getVersion()}.`,
        }).then(() => false);
      }
      return Promise.resolve(false);
    }
    if (!supportsSelfUpdate) return Promise.resolve(false);
    if (!started) start();
    if (phase === "ready") return promptToInstall({ requestedByUser: manual });
    if (phase === "installing" || installRequested) return Promise.resolve(false);
    if (currentOperation) {
      if (manual) interactive = true;
      return currentOperation;
    }

    interactive = manual;
    setState("checking", null);
    const failureAtStart = failureGeneration;
    const generation = lifecycleGeneration;
    let operation;
    operation = (async () => {
      try {
        const result = await autoUpdater.checkForUpdates();
        if (!result) {
          if (isLive(generation) && phase === "checking") {
            handleFailure(new Error("The update service is unavailable."), generation);
          }
          return false;
        }
        if (result.downloadPromise) await result.downloadPromise;
        return isLive(generation);
      } catch (error) {
        if (isLive(generation) && failureGeneration === failureAtStart) handleFailure(error, generation);
        return false;
      } finally {
        if (currentOperation === operation) currentOperation = null;
      }
    })();
    currentOperation = operation;
    return operation;
  }

  function checkNow() {
    return check({ manual: true });
  }

  function conversionFinished() {
    if (!deferredPrompt || hasActiveJobs()) return Promise.resolve(false);
    return promptToInstall().catch((error) => {
      logFailure(error);
      return false;
    });
  }

  function menuLabel() {
    if (!supportsSelfUpdate) return "View Loopdrop Updates…";
    if (phase === "checking") return "Checking for Updates…";
    if (phase === "downloading") return `Downloading Loopdrop ${version || "Update"}…`;
    if (phase === "ready") return `Restart to Install Loopdrop ${version || "Update"}`;
    if (phase === "installing") return `Installing Loopdrop ${version || "Update"}…`;
    return "Check for Updates…";
  }

  return {
    check,
    checkNow,
    conversionFinished,
    getState: snapshot,
    menuLabel,
    promptToInstall,
    start,
    stop,
  };
}

module.exports = {
  createUpdateManager,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_INTERVAL_MS,
};
