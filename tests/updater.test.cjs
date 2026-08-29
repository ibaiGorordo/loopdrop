const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { createUpdateManager } = require("../electron/updater.cjs");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fakeTimers() {
  const timeouts = [];
  const intervals = [];
  function timer(list, callback, delay) {
    const handle = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
    list.push(handle);
    return handle;
  }
  return {
    intervals,
    timeouts,
    clearInterval: () => {},
    clearTimeout: () => {},
    setInterval: (callback, delay) => timer(intervals, callback, delay),
    setTimeout: (callback, delay) => timer(timeouts, callback, delay),
  };
}

function harness({ platform = "darwin", packaged = true, active = false } = {}) {
  const updater = new EventEmitter();
  const messages = [];
  const notifications = [];
  const warnings = [];
  const responses = [];
  const timers = fakeTimers();
  let activeJobs = active;
  let checks = 0;
  let quits = 0;
  const installRequests = [];

  updater.checkForUpdates = async () => {
    checks += 1;
    updater.emit("checking-for-update");
    updater.emit("update-not-available", { version: "0.1.0" });
    return { updateInfo: { version: "0.1.0" } };
  };
  updater.quitAndInstall = () => { quits += 1; };

  const manager = createUpdateManager({
    app: { isPackaged: packaged, getVersion: () => "0.1.0" },
    autoUpdater: updater,
    dialog: {
      showMessageBox: async (...args) => {
        messages.push(args.at(-1));
        return { response: responses.length > 0 ? responses.shift() : 1 };
      },
    },
    hasActiveJobs: () => activeJobs,
    setInstallRequested: (requested) => installRequests.push(requested),
    notify: (title, body) => notifications.push({ title, body }),
    logger: { warn: (message) => warnings.push(message) },
    platform,
    timers,
  });

  return {
    get checks() { return checks; },
    get quits() { return quits; },
    installRequests,
    manager,
    messages,
    notifications,
    responses,
    setActive(value) { activeJobs = value; },
    timers,
    updater,
    warnings,
  };
}

test("supported packaged apps schedule quiet periodic checks with hardened updater settings", async () => {
  const testHarness = harness();
  assert.equal(testHarness.manager.start(), true);
  assert.equal(testHarness.timers.timeouts.length, 1);
  assert.equal(testHarness.timers.intervals.length, 1);
  assert.equal(testHarness.timers.timeouts[0].unrefCalled, true);
  assert.equal(testHarness.timers.intervals[0].unrefCalled, true);
  assert.equal(testHarness.updater.autoDownload, true);
  assert.equal(testHarness.updater.autoInstallOnAppQuit, true);
  assert.equal(testHarness.updater.allowPrerelease, false);
  assert.equal(testHarness.updater.allowDowngrade, false);
  assert.equal(testHarness.updater.disableWebInstaller, true);

  await testHarness.manager.check();
  assert.equal(testHarness.checks, 1);
  assert.equal(testHarness.messages.length, 0);
});

test("a manual check reports that the installed app is current", async () => {
  const testHarness = harness();
  testHarness.manager.start();
  await testHarness.manager.checkNow();
  assert.equal(testHarness.messages.length, 1);
  assert.equal(testHarness.messages[0].message, "Loopdrop is up to date.");
  assert.match(testHarness.messages[0].detail, /version 0\.1\.0/);
});

test("a late update download failure is caught and shown only for a manual check", async () => {
  const testHarness = harness();
  testHarness.updater.checkForUpdates = async () => {
    testHarness.updater.emit("update-available", { version: "0.2.0" });
    return { downloadPromise: Promise.reject(new Error("download failed")) };
  };
  testHarness.manager.start();
  const result = await testHarness.manager.checkNow();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result, false);
  assert.equal(testHarness.notifications.length, 1);
  assert.equal(testHarness.messages.length, 1);
  assert.equal(testHarness.messages[0].message, "Loopdrop couldn’t check for updates.");
  assert.equal(testHarness.warnings.length, 1);
});

test("concurrent checks share one updater operation", async () => {
  const testHarness = harness();
  const pending = deferred();
  testHarness.updater.checkForUpdates = () => {
    testHarness.updater.emit("checking-for-update");
    return pending.promise;
  };
  testHarness.manager.start();
  const first = testHarness.manager.check();
  const second = testHarness.manager.check();
  assert.equal(first, second);
  pending.resolve({ updateInfo: { version: "0.1.0" } });
  await first;
});

test("a ready update waits for conversion completion before offering a restart", async () => {
  const testHarness = harness({ active: true });
  testHarness.manager.start();
  testHarness.updater.emit("update-downloaded", { version: "0.2.0" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(testHarness.notifications.length, 1);
  assert.equal(testHarness.messages.length, 0);
  assert.equal(testHarness.manager.menuLabel(), "Restart to Install Loopdrop 0.2.0");

  testHarness.setActive(false);
  testHarness.responses.push(1);
  await testHarness.manager.conversionFinished();
  assert.equal(testHarness.messages.length, 1);
  assert.equal(testHarness.quits, 0);

  testHarness.responses.push(0);
  await testHarness.manager.checkNow();
  assert.equal(testHarness.quits, 1);
  assert.deepEqual(testHarness.installRequests, [true]);
  assert.equal(testHarness.manager.getState().phase, "installing");
});

test("a conversion started while the restart dialog is open still defers installation", async () => {
  const updater = new EventEmitter();
  const response = deferred();
  const notifications = [];
  const timers = fakeTimers();
  let active = false;
  let quits = 0;
  updater.checkForUpdates = async () => ({ updateInfo: { version: "0.2.0" } });
  updater.quitAndInstall = () => { quits += 1; };
  const manager = createUpdateManager({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    autoUpdater: updater,
    dialog: { showMessageBox: () => response.promise },
    hasActiveJobs: () => active,
    notify: (title, body) => notifications.push({ title, body }),
    platform: "darwin",
    timers,
  });
  manager.start();
  updater.emit("update-downloaded", { version: "0.2.0" });
  await new Promise((resolve) => setImmediate(resolve));
  active = true;
  response.resolve({ response: 0 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(quits, 0);
  assert.equal(notifications.at(-1).title, "Loopdrop update waiting");
});

test("a failed install request restores the ready state and conversion guard", async () => {
  const testHarness = harness();
  testHarness.updater.quitAndInstall = () => { throw new Error("installer launch failed"); };
  testHarness.responses.push(0);
  testHarness.manager.start();
  testHarness.updater.emit("update-downloaded", { version: "0.2.0" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(testHarness.installRequests, [true, false]);
  assert.equal(testHarness.manager.getState().phase, "ready");
  assert.equal(testHarness.manager.getState().installRequested, false);
  assert.equal(testHarness.messages.at(-1).message, "Loopdrop couldn’t install the update.");
  assert.match(testHarness.warnings.at(-1), /installer launch failed/);
});

test("an updater error after installation was requested releases the conversion guard", async () => {
  const testHarness = harness();
  testHarness.responses.push(0);
  testHarness.manager.start();
  testHarness.updater.emit("update-downloaded", { version: "0.2.0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(testHarness.manager.getState().installRequested, true);

  testHarness.updater.emit("error", new Error("native updater failed"));
  assert.deepEqual(testHarness.installRequests, [true, false]);
  assert.equal(testHarness.manager.getState().phase, "idle");
  assert.equal(testHarness.manager.getState().installRequested, false);
  assert.equal(testHarness.messages.at(-1).message, "Loopdrop couldn’t install the update.");
});

test("a synchronous updater error event prevents a false successful-install state", async () => {
  const testHarness = harness();
  testHarness.updater.quitAndInstall = () => {
    testHarness.updater.emit("error", new Error("synchronous native updater failure"));
  };
  testHarness.responses.push(0);
  testHarness.manager.start();
  testHarness.updater.emit("update-downloaded", { version: "0.2.0" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(testHarness.installRequests, [true, false]);
  assert.equal(testHarness.manager.getState().phase, "idle");
  assert.equal(testHarness.manager.getState().installRequested, false);
  assert.equal(testHarness.messages.at(-1).message, "Loopdrop couldn’t install the update.");
  assert.match(testHarness.warnings.at(-1), /synchronous native updater failure/);
});

test("active-conversion dialogs are serialized and restart prompt follows safely", async () => {
  const updater = new EventEmitter();
  const firstDialog = deferred();
  const timers = fakeTimers();
  let active = true;
  let dialogCalls = 0;
  updater.checkForUpdates = async () => ({ updateInfo: { version: "0.2.0" } });
  updater.quitAndInstall = () => {};
  const manager = createUpdateManager({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    autoUpdater: updater,
    dialog: {
      showMessageBox: () => {
        dialogCalls += 1;
        return dialogCalls === 1 ? firstDialog.promise : Promise.resolve({ response: 1 });
      },
    },
    hasActiveJobs: () => active,
    platform: "darwin",
    timers,
  });
  manager.start();
  updater.emit("update-downloaded", { version: "0.2.0" });
  await new Promise((resolve) => setImmediate(resolve));

  const first = manager.checkNow();
  const second = manager.checkNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dialogCalls, 1);

  active = false;
  const conversionFinished = manager.conversionFinished();
  firstDialog.resolve({ response: 0 });
  await Promise.all([first, second, conversionFinished]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dialogCalls, 2);
});

test("stopping the manager invalidates pending checks and install dialogs", async () => {
  const updater = new EventEmitter();
  const checkResult = deferred();
  const dialogResult = deferred();
  const timers = fakeTimers();
  let quits = 0;
  const warnings = [];
  updater.checkForUpdates = () => checkResult.promise;
  updater.quitAndInstall = () => { quits += 1; };
  const manager = createUpdateManager({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    autoUpdater: updater,
    dialog: { showMessageBox: () => dialogResult.promise },
    logger: { warn: (message) => warnings.push(message) },
    platform: "darwin",
    timers,
  });
  manager.start();
  const pendingCheck = manager.checkNow();
  updater.emit("update-downloaded", { version: "0.2.0" });
  await new Promise((resolve) => setImmediate(resolve));
  manager.stop();
  timers.timeouts[0].callback();
  dialogResult.resolve({ response: 0 });
  checkResult.reject(new Error("late network failure"));
  await pendingCheck;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(quits, 0);
  assert.equal(warnings.length, 0);
  assert.equal(timers.timeouts.length, 1);
  assert.deepEqual(manager.getState(), {
    phase: "idle",
    version: null,
    supportsSelfUpdate: true,
    installRequested: false,
  });
});

test("Linux packages never invoke the unsigned self-update path", async () => {
  const testHarness = harness({ platform: "linux" });
  assert.equal(testHarness.manager.start(), false);
  assert.equal(await testHarness.manager.checkNow(), false);
  assert.equal(testHarness.checks, 0);
  assert.equal(testHarness.manager.menuLabel(), "View Loopdrop Updates…");
});

test("development builds explain why update checks are unavailable", async () => {
  const testHarness = harness({ packaged: false });
  assert.equal(testHarness.manager.start(), false);
  assert.equal(await testHarness.manager.checkNow(), false);
  assert.equal(testHarness.checks, 0);
  assert.equal(testHarness.messages[0].message, "Update checks are available in installed builds.");
});
