"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AppSettings,
  ClipPreset,
  DEFAULT_APP_SETTINGS,
  loadAppSettings,
  MiniQuality,
  saveAppSettings,
  SizePreset,
} from "./settings";

type GifResult = {
  url: string;
  size: number;
  width: number;
  height: number;
  frames: number;
  outputPath: string;
};

type MiniSource = LocalVideo & { ownedUrl: boolean };

const MAX_FRAMES = 300;

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function MiniApp() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceRef = useRef<MiniSource | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const cancelRef = useRef(false);

  const [source, setSource] = useState<MiniSource | null>(null);
  const [totalDuration, setTotalDuration] = useState(0);
  const [sourceWidth, setSourceWidth] = useState(0);
  const [sourceHeight, setSourceHeight] = useState(0);
  const [clipPreset, setClipPreset] = useState<ClipPreset>(() => loadAppSettings().miniClipPreset);
  const [quality, setQuality] = useState<MiniQuality>(() => loadAppSettings().miniQuality);
  const [dragging, setDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Drop a video to begin");
  const [error, setError] = useState("");
  const [result, setResult] = useState<GifResult | null>(null);

  function loadSource(next: LocalVideo, ownedUrl = false) {
    if (sourceRef.current?.ownedUrl) URL.revokeObjectURL(sourceRef.current.previewUrl);
    const prepared = { ...next, ownedUrl };
    sourceRef.current = prepared;
    setSource(prepared);
    setTotalDuration(next.duration);
    setSourceWidth(next.width);
    setSourceHeight(next.height);
    const defaults = loadAppSettings();
    setClipPreset(defaults.miniClipPreset);
    setQuality(defaults.miniQuality);
    setProgress(0);
    setResult(null);
    setError("");
    setStatus("Ready to create");
  }

  function clearSource() {
    if (processing) return;
    if (sourceRef.current?.ownedUrl) URL.revokeObjectURL(sourceRef.current.previewUrl);
    void window.loopdrop.clearMiniVideo();
    sourceRef.current = null;
    setSource(null);
    setTotalDuration(0);
    setSourceWidth(0);
    setSourceHeight(0);
    setProgress(0);
    setResult(null);
    setError("");
    setStatus("Drop a video to begin");
  }

  useEffect(() => {
    if (!window.loopdrop) return undefined;
    const unsubscribeProgress = window.loopdrop.onProgress(({ jobId, percent, message }) => {
      if (jobId !== jobIdRef.current) return;
      setProgress(percent);
      setStatus(message);
    });
    const unsubscribeFile = window.loopdrop.onMiniFile((file) => loadSource(file));
    void window.loopdrop.getMiniVideo().then((file) => {
      if (file && !sourceRef.current) loadSource(file);
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void window.loopdrop.hideMini();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      unsubscribeProgress();
      unsubscribeFile();
      window.removeEventListener("keydown", onKeyDown);
      if (sourceRef.current?.ownedUrl) URL.revokeObjectURL(sourceRef.current.previewUrl);
    };
  }, []);

  const fps = quality === "compact" ? 8 : 12;
  const colors = quality === "compact" ? 64 : 128;
  const requestedDuration = clipPreset === "full" ? totalDuration : Number(clipPreset);
  const clipDuration = Math.max(0, Math.min(requestedDuration, totalDuration, 60, MAX_FRAMES / fps));
  const frameCount = Math.max(1, Math.ceil(clipDuration * fps));
  const outputSize = useMemo(() => {
    if (!sourceWidth || !sourceHeight) return { width: 480, height: 0 };
    const makeEven = (value: number) => Math.max(2, Math.round(value / 2) * 2);
    if (quality === "hd") return { width: makeEven((720 * sourceWidth) / sourceHeight), height: 720 };
    const width = quality === "compact" ? 320 : 480;
    return { width, height: makeEven((width * sourceHeight) / sourceWidth) };
  }, [quality, sourceHeight, sourceWidth]);

  function onMetadata() {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration < 0.05) {
      setError("This video does not have a readable duration.");
      return;
    }
    setTotalDuration(video.duration);
    setSourceWidth(video.videoWidth);
    setSourceHeight(video.videoHeight);
    setStatus("Ready to create");
  }

  async function chooseVideo() {
    try {
      const chosen = await window.loopdrop.chooseVideo();
      if (chosen) loadSource(chosen);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The video could not be opened.");
    }
  }

  async function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    const inputPath = window.loopdrop.getPathForFile(file);
    if (!inputPath || !/\.(avi|m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm|wmv)$/i.test(file.name)) {
      setError("Drop a common video file such as MP4, MOV, M4V, or WebM.");
      return;
    }
    try {
      const remembered = await window.loopdrop.rememberMiniVideo(inputPath);
      if (!remembered) throw new Error("The video could not be opened.");
      loadSource(remembered);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The video could not be opened.");
    }
  }

  async function generate() {
    if (!source || !totalDuration || clipDuration < 0.05) return;
    if (frameCount > MAX_FRAMES) {
      setError(`Lower FPS or shorten the clip to stay under ${MAX_FRAMES} frames.`);
      return;
    }
    const jobId = crypto.randomUUID();
    jobIdRef.current = jobId;
    cancelRef.current = false;
    setProcessing(true);
    setProgress(0);
    setResult(null);
    setError("");
    setStatus("Starting native converter…");
    videoRef.current?.pause();
    try {
      const converted = await window.loopdrop.convert({
        jobId,
        inputPath: source.inputPath,
        sourceName: source.name,
        start: 0,
        duration: clipDuration,
        fps,
        width: outputSize.width,
        height: outputSize.height,
        colors,
        loop: true,
      });
      if (cancelRef.current) throw new Error("cancelled");
      setResult({
        url: converted.previewUrl,
        size: converted.size,
        width: outputSize.width,
        height: outputSize.height,
        frames: frameCount,
        outputPath: converted.outputPath,
      });
      setProgress(100);
      setStatus("Saved automatically to Downloads");
    } catch (caught) {
      if (cancelRef.current) {
        setStatus("Conversion cancelled");
        setProgress(0);
      } else {
        setError(caught instanceof Error ? caught.message : "The GIF could not be created.");
        setStatus("Couldn’t finish conversion");
      }
    } finally {
      jobIdRef.current = null;
      setProcessing(false);
    }
  }

  return (
    <main className="mini-shell">
      <header className="mini-header">
        <div className="mini-brand"><span className="mini-brand-mark" /><div><strong>loopdrop</strong><small>MINI CONVERTER</small></div></div>
        <div className="mini-window-actions">
          <button type="button" onClick={() => window.loopdrop.openFullApp()} title="Open full app" aria-label="Open full app">↗</button>
          <button type="button" onClick={() => window.loopdrop.hideMini()} title="Close mini converter" aria-label="Close mini converter">×</button>
        </div>
      </header>

      <section className="mini-content">
        {!source ? (
          <div
            className={`mini-dropzone ${dragging ? "dragging" : ""}`}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => void onDrop(event)}
            onClick={chooseVideo}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void chooseVideo(); }}
          >
            <span className="mini-drop-icon" aria-hidden="true">＋</span>
            <strong>Drop a video</strong>
            <p>or click to choose one</p>
            <small>MP4 · MOV · M4V · WEBM</small>
          </div>
        ) : (
          <div className="mini-workspace">
            <div className="mini-media-card">
              <button className="mini-clear-media" type="button" onClick={clearSource} disabled={processing} title="Clear video" aria-label="Clear video">×</button>
              {result ? (
                <img src={result.url} alt="Generated GIF preview" />
              ) : (
                <video ref={videoRef} src={source.previewUrl} controls playsInline preload="metadata" onLoadedMetadata={onMetadata} onError={() => setError("Preview unavailable for this codec. GIF conversion still works.")} />
              )}
              <div className="mini-file-row">
                <div><strong title={source.name}>{source.name}</strong><small>{formatSize(source.size)}{totalDuration ? ` · ${formatTime(totalDuration)}` : ""}</small></div>
              </div>
            </div>

            <div className="mini-sidecar">
              <div className={`mini-controls mini-simple-controls ${result ? "muted" : ""}`}>
                <label><span>CLIP</span><select value={clipPreset} onChange={(event) => { setClipPreset(event.target.value as ClipPreset); setResult(null); }} disabled={processing || Boolean(result)}><option value="3">First 3 sec</option><option value="5">First 5 sec</option><option value="10">First 10 sec</option><option value="full">Full clip</option></select></label>
                <label><span>QUALITY</span><select value={quality} onChange={(event) => { setQuality(event.target.value as MiniQuality); setResult(null); }} disabled={processing || Boolean(result)}><option value="compact">Compact</option><option value="balanced">Balanced</option><option value="hd">HD</option></select></label>
                <small>{`${frameCount}f · ${outputSize.width}×${outputSize.height || "—"}`}</small>
              </div>

              <div className="mini-action-area">
                {processing ? (
                  <div className="mini-progress">
                    <div><strong>{status}</strong><span>{progress}%</span></div>
                    <div className="mini-progress-track" role="progressbar" aria-label="GIF conversion progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
                    <button type="button" onClick={() => { cancelRef.current = true; if (jobIdRef.current) window.loopdrop.cancel(jobIdRef.current); }}>Cancel</button>
                  </div>
                ) : result ? (
                  <div className="mini-result-row"><div><strong>GIF ready</strong><small>{formatSize(result.size)}</small></div><button type="button" onClick={() => window.loopdrop.showInFolder(result.outputPath)}>Finder</button><button className="mini-adjust" type="button" onClick={() => { setResult(null); setStatus("Ready to create"); }}>Adjust</button></div>
                ) : (
                  <button className="mini-generate" type="button" onClick={generate} disabled={!totalDuration}>Create GIF <span>→</span></button>
                )}
              </div>
              <div className={`mini-status-line ${error ? "error" : ""}`} role={error ? "alert" : "status"} aria-live="polite">{error || status}</div>
            </div>
          </div>
        )}

        {!source && error && <div className="mini-error" role="alert">{error}</div>}
      </section>
    </main>
  );
}

type SettingsDialogProps = {
  settings: AppSettings;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
};

function SettingsDialog({ settings, onClose, onSave }: SettingsDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState<AppSettings>(settings);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function update<K extends Exclude<keyof AppSettings, "version">>(key: K, value: AppSettings[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="defaults-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="defaults-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="defaults-title" tabIndex={-1}>
        <div className="defaults-header">
          <div><p className="eyebrow">APP SETTINGS</p><h2 id="defaults-title">Default conversion settings</h2></div>
          <button type="button" onClick={onClose} aria-label="Close settings">×</button>
        </div>
        <p className="defaults-intro">Applied when you add a new video. Your current conversion stays unchanged.</p>

        <div className="defaults-section">
          <p>CLIP DEFAULTS</p>
          <div className="defaults-grid">
            <label><span>FULL APP CLIP</span><select value={draft.fullClipPreset} onChange={(event) => update("fullClipPreset", event.target.value as ClipPreset)}><option value="3">First 3 seconds</option><option value="5">First 5 seconds</option><option value="10">First 10 seconds</option><option value="full">Full clip</option></select></label>
            <label><span>MINI CLIP</span><select value={draft.miniClipPreset} onChange={(event) => update("miniClipPreset", event.target.value as ClipPreset)}><option value="3">First 3 seconds</option><option value="5">First 5 seconds</option><option value="10">First 10 seconds</option><option value="full">Full clip</option></select></label>
            <label><span>MINI QUALITY</span><select value={draft.miniQuality} onChange={(event) => update("miniQuality", event.target.value as MiniQuality)}><option value="compact">Compact · 320 px</option><option value="balanced">Balanced · 480 px</option><option value="hd">HD · 720p</option></select></label>
          </div>
        </div>

        <div className="defaults-section">
          <p>FULL APP EXPORT</p>
          <div className="defaults-grid">
            <label><span>OUTPUT SIZE</span><select value={draft.sizePreset} onChange={(event) => update("sizePreset", event.target.value as SizePreset)}><option value="w320">320 px wide</option><option value="w480">480 px wide</option><option value="w640">640 px wide</option><option value="h720">720p · HD</option><option value="h1080">1080p · Full HD</option><option value="original">Original size</option></select></label>
            <label><span>FRAME RATE</span><select value={draft.fps} onChange={(event) => update("fps", Number(event.target.value) as AppSettings["fps"])}><option value="8">8 fps · Small</option><option value="12">12 fps · Smooth</option><option value="15">15 fps</option><option value="20">20 fps · Extra</option></select></label>
            <label><span>COLOR QUALITY</span><select value={draft.colors} onChange={(event) => update("colors", Number(event.target.value) as AppSettings["colors"])}><option value="64">64 colors · Small</option><option value="128">128 colors</option><option value="192">192 colors</option><option value="256">256 colors · Crisp</option></select></label>
            <div className="defaults-loop-row"><div><span>LOOP GIF</span><small>Repeat continuously</small></div><button className={`switch ${draft.loop ? "on" : ""}`} type="button" role="switch" aria-checked={draft.loop} onClick={() => update("loop", !draft.loop)}><span /></button></div>
          </div>
        </div>

        <div className="defaults-actions">
          <button className="defaults-reset" type="button" onClick={() => setDraft({ ...DEFAULT_APP_SETTINGS })}>Reset defaults</button>
          <div><button type="button" onClick={onClose}>Cancel</button><button className="defaults-save" type="button" onClick={() => onSave(draft)}>Save defaults</button></div>
        </div>
      </section>
    </div>
  );
}

function FullApp() {
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cancelRef = useRef(false);
  const jobIdRef = useRef<string | null>(null);
  const sourceUrlRef = useRef<string | null>(null);
  const resultUrlRef = useRef<string | null>(null);
  const sourceSettingsRef = useRef<AppSettings>(loadAppSettings());
  const sourceInitializedRef = useRef(false);
  const sourceTokenRef = useRef(0);

  const [savedSettings, setSavedSettings] = useState<AppSettings>(() => loadAppSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [inputPath, setInputPath] = useState("");
  const [duration, setDuration] = useState(0);
  const [sourceWidth, setSourceWidth] = useState(0);
  const [sourceHeight, setSourceHeight] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [sizePreset, setSizePreset] = useState<SizePreset>(savedSettings.sizePreset);
  const [fps, setFps] = useState(savedSettings.fps);
  const [colors, setColors] = useState(savedSettings.colors);
  const [loop, setLoop] = useState(savedSettings.loop);
  const [dragging, setDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Ready when you are");
  const [error, setError] = useState("");
  const [result, setResult] = useState<GifResult | null>(null);

  useEffect(() => {
    const unsubscribe = window.loopdrop.onProgress(({ jobId, percent, message }) => {
      if (jobId !== jobIdRef.current) return;
      setProgress(percent);
      setStatus(message);
    });
    const unsubscribeSettings = window.loopdrop.onOpenSettings(() => setSettingsOpen(true));

    return () => {
      unsubscribe();
      unsubscribeSettings();
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    };
  }, []);

  const frameCount = useMemo(
    () => Math.max(1, Math.ceil(Math.max(0, end - start) * fps)),
    [end, fps, start],
  );

  const outputSize = useMemo(() => {
    if (!sourceWidth || !sourceHeight) return { width: 480, height: 0 };
    if (sizePreset === "original") return { width: sourceWidth, height: sourceHeight };

    const makeEven = (value: number) => Math.max(2, Math.round(value / 2) * 2);
    const axis = sizePreset.charAt(0);
    const value = Number(sizePreset.slice(1));
    if (axis === "h") {
      return { width: makeEven((value * sourceWidth) / sourceHeight), height: value };
    }
    return { width: value, height: makeEven((value * sourceHeight) / sourceWidth) };
  }, [sizePreset, sourceHeight, sourceWidth]);

  function clearResult() {
    resultUrlRef.current = null;
    setResult(null);
  }

  function loadFile(nextFile: File | undefined) {
    if (!nextFile) return;
    if (!/\.(avi|m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm|wmv)$/i.test(nextFile.name)) {
      setError("Choose a common video file such as MP4, MOV, M4V, MKV, or WebM.");
      return;
    }

    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    clearResult();
    const nextUrl = URL.createObjectURL(nextFile);
    const nextPath = window.loopdrop.getPathForFile(nextFile);
    if (!nextPath) {
      setError("loopdrop could not access that file. Try choosing it again.");
      URL.revokeObjectURL(nextUrl);
      return;
    }
    sourceUrlRef.current = nextUrl;
    const sourceToken = sourceTokenRef.current + 1;
    sourceTokenRef.current = sourceToken;
    const defaults = loadAppSettings();
    sourceSettingsRef.current = defaults;
    sourceInitializedRef.current = false;
    setFile(nextFile);
    setInputPath(nextPath);
    setDuration(0);
    setStart(0);
    setEnd(0);
    setSizePreset(defaults.sizePreset);
    setFps(defaults.fps);
    setColors(defaults.colors);
    setLoop(defaults.loop);
    setProgress(0);
    setError("");
    setStatus("Reading video…");
    if (videoRef.current) videoRef.current.src = nextUrl;
    void window.loopdrop.inspectVideo(nextPath).then((metadata) => {
      if (sourceTokenRef.current !== sourceToken) return;
      initializeSource(metadata.duration, metadata.width, metadata.height);
    }).catch((caught) => {
      if (sourceTokenRef.current !== sourceToken || sourceInitializedRef.current) return;
      setError(caught instanceof Error ? caught.message : "FFmpeg could not read this video.");
      setStatus("Couldn’t read video metadata");
    });
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    loadFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    loadFile(event.dataTransfer.files?.[0]);
  }

  function initializeSource(sourceDuration: number, width: number, height: number) {
    if (!Number.isFinite(sourceDuration) || sourceDuration < 0.05 || width < 1 || height < 1) return false;
    setSourceWidth(width);
    setSourceHeight(height);
    if (sourceInitializedRef.current) return true;
    sourceInitializedRef.current = true;
    const defaults = sourceSettingsRef.current;
    const requestedClip = defaults.fullClipPreset === "full" ? sourceDuration : Number(defaults.fullClipPreset);
    const clipEnd = Math.min(sourceDuration, requestedClip, 60, MAX_FRAMES / defaults.fps);
    setDuration(sourceDuration);
    setStart(0);
    setEnd(Number(clipEnd.toFixed(2)));
    setSizePreset(defaults.sizePreset);
    setFps(defaults.fps);
    setColors(defaults.colors);
    setLoop(defaults.loop);
    setStatus(clipEnd >= sourceDuration - 0.01 ? "Full video selected" : `First ${formatTime(clipEnd)} selected`);
    return true;
  }

  function onMetadata() {
    const video = videoRef.current;
    if (!video || !initializeSource(video.duration, video.videoWidth, video.videoHeight)) {
      setError("This video does not have readable metadata.");
    }
  }

  function saveDefaults(next: AppSettings) {
    const saved = saveAppSettings(next);
    setSavedSettings(saved);
    setSettingsOpen(false);
    if (!file) {
      sourceSettingsRef.current = saved;
      setSizePreset(saved.sizePreset);
      setFps(saved.fps);
      setColors(saved.colors);
      setLoop(saved.loop);
      setStatus("Defaults saved");
    } else {
      setStatus("Defaults saved for the next video");
    }
  }

  async function convert() {
    const video = videoRef.current;
    if (!video || !file || !inputPath || !duration) return;
    if (end <= start) {
      setError("The end time needs to be after the start time.");
      return;
    }
    if (frameCount > MAX_FRAMES) {
      setError(`This selection is ${frameCount} frames. Shorten it or lower FPS to stay under ${MAX_FRAMES} frames.`);
      return;
    }

    const { width, height } = outputSize;
    clearResult();
    cancelRef.current = false;
    setProcessing(true);
    setError("");
    setProgress(0);
    setStatus("Preparing frames…");

    const jobId = crypto.randomUUID();
    jobIdRef.current = jobId;
    try {
      video.pause();
      setStatus("Starting native converter — safe to switch apps");
      const converted = await window.loopdrop.convert({
        jobId,
        inputPath,
        sourceName: file.name,
        start,
        duration: end - start,
        fps,
        width,
        height,
        colors,
        loop,
      });
      if (cancelRef.current) throw new Error("cancelled");
      resultUrlRef.current = converted.previewUrl;
      setResult({
        url: converted.previewUrl,
        size: converted.size,
        width,
        height,
        frames: frameCount,
        outputPath: converted.outputPath,
      });
      setStatus(`GIF saved to ${converted.outputName}`);
      setProgress(100);
    } catch (caught) {
      if (
        cancelRef.current ||
        (caught instanceof Error && caught.message === "cancelled")
      ) {
        setStatus("Conversion cancelled");
        setProgress(0);
      } else {
        setError(caught instanceof Error ? caught.message : "Something went wrong while creating the GIF.");
        setStatus("Couldn’t finish conversion");
      }
    } finally {
      jobIdRef.current = null;
      setProcessing(false);
    }
  }

  function updateStart(value: number) {
    const next = Math.min(Math.max(0, value), Math.max(0, end - 0.1));
    setStart(Number(next.toFixed(2)));
    if (videoRef.current) videoRef.current.currentTime = next;
    clearResult();
  }

  function updateEnd(value: number) {
    const next = Math.max(Math.min(duration, value), Math.min(duration, start + 0.1));
    setEnd(Number(next.toFixed(2)));
    if (videoRef.current) videoRef.current.currentTime = next;
    clearResult();
  }

  return (
    <main>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#top" aria-label="Loopdrop home">
            <span className="brand-mark" aria-hidden="true"><span /></span>
            <span>loopdrop</span>
          </a>
          <div className="topbar-actions">
            <button className="defaults-trigger" type="button" onClick={() => setSettingsOpen(true)}><span aria-hidden="true">⚙</span> Defaults</button>
            <div className="privacy-pill"><span aria-hidden="true">●</span> Private &amp; on-device</div>
          </div>
        </div>
      </header>

      {settingsOpen && <SettingsDialog settings={savedSettings} onClose={() => setSettingsOpen(false)} onSave={saveDefaults} />}

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">VIDEO TO GIF</p>
          <h1>Create a polished GIF.</h1>
          <p className="intro">Trim the moment, tune the quality, and export—without your video ever leaving this computer.</p>
        </div>
        <div className="engine-badge"><span>FF</span><div><strong>Native engine</strong><small>Fast background conversion</small></div></div>
      </section>

      <section className={`workspace ${file ? "has-file" : ""}`} aria-label="Video to GIF converter">
        <div className="source-panel">
          <div className="panel-heading">
            <span className="step-number">01</span>
            <div><p className="step-label">SOURCE</p><h2>Video preview</h2></div>
          </div>

          <input ref={inputRef} className="visually-hidden" type="file" accept="video/*,.avi,.m4v,.mkv,.mov,.mp4,.mpeg,.mpg,.ogv,.webm,.wmv" onChange={onFileChange} />
          {!file ? (
            <div
              className={`dropzone ${dragging ? "dragging" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") inputRef.current?.click(); }}
              role="button"
              tabIndex={0}
            >
              <div className="upload-glyph" aria-hidden="true"><span>↑</span></div>
              <h3>Drop your video here</h3>
              <p>or choose a file from this computer</p>
              <button type="button" className="browse-button">Choose video <span>＋</span></button>
              <small>MP4 · MOV · M4V · WEBM</small>
            </div>
          ) : (
            <div className="video-card">
              <video ref={videoRef} src={sourceUrlRef.current ?? undefined} controls playsInline preload="auto" onLoadedMetadata={onMetadata} onError={() => setError("Preview unavailable for this codec. GIF conversion still works.")} />
              <div className="file-strip">
                <span className="file-badge">VID</span>
                <div><strong title={file.name}>{file.name}</strong><small>{formatSize(file.size)} · {formatTime(duration)}</small></div>
                <button type="button" onClick={() => inputRef.current?.click()}>Replace</button>
              </div>
            </div>
          )}
        </div>

        <div className="settings-panel">
          <div className="panel-heading">
            <span className="step-number">02</span>
            <div><p className="step-label">SETTINGS</p><h2>Export controls</h2></div>
          </div>

          <div className={`settings-body ${!file ? "is-disabled" : ""}`} aria-disabled={!file}>
            <div className="setting-block timeline-block">
              <div className="setting-title"><label>Clip range</label><output>{formatTime(start)} → {formatTime(end)}</output></div>
              <div className="timeline" style={{ "--start": `${duration ? (start / duration) * 100 : 0}%`, "--end": `${duration ? (end / duration) * 100 : 100}%` } as React.CSSProperties}>
                <div className="timeline-track"><span /></div>
                <input aria-label="Start time" type="range" min="0" max={duration || 1} step="0.05" value={start} onChange={(event) => updateStart(Number(event.target.value))} disabled={!file || processing} />
                <input aria-label="End time" type="range" min="0" max={duration || 1} step="0.05" value={end || 1} onChange={(event) => updateEnd(Number(event.target.value))} disabled={!file || processing} />
              </div>
              <div className="time-inputs">
                <label>START <input type="number" min="0" max={end} step="0.1" value={start} onChange={(event) => updateStart(Number(event.target.value))} disabled={!file || processing} /></label>
                <span>→</span>
                <label>END <input type="number" min={start} max={duration} step="0.1" value={end} onChange={(event) => updateEnd(Number(event.target.value))} disabled={!file || processing} /></label>
              </div>
            </div>

            <div className="settings-grid">
              <label className="select-field"><span>OUTPUT SIZE</span><select value={sizePreset} onChange={(event) => { setSizePreset(event.target.value as SizePreset); clearResult(); }} disabled={!file || processing}>
                <option value="w320">320 px wide · Small</option>
                <option value="w480">480 px wide</option>
                <option value="w640">640 px wide</option>
                <option value="h720">720p · HD</option>
                <option value="h1080">1080p · Full HD</option>
                {sourceWidth > 0 && <option value="original">Original · {sourceWidth} × {sourceHeight}</option>}
              </select></label>
              <label className="select-field"><span>FRAME RATE</span><select value={fps} onChange={(event) => { setFps(Number(event.target.value) as AppSettings["fps"]); clearResult(); }} disabled={!file || processing}>
                <option value="8">8 fps · Small</option><option value="12">12 fps · Smooth</option><option value="15">15 fps</option><option value="20">20 fps · Extra</option>
              </select></label>
            </div>

            <div className="setting-block">
              <div className="setting-title"><label htmlFor="quality">Color quality</label><output>{colors} colors</output></div>
              <input id="quality" className="quality-range" type="range" min="64" max="256" step="64" value={colors} onChange={(event) => { setColors(Number(event.target.value) as AppSettings["colors"]); clearResult(); }} disabled={!file || processing} />
              <div className="range-legend"><span>SMALLER</span><span>CRISPER</span></div>
            </div>

            <div className="loop-row">
              <div><strong>Loop continuously</strong><small>Repeat the GIF indefinitely</small></div>
              <button className={`switch ${loop ? "on" : ""}`} type="button" role="switch" aria-checked={loop} onClick={() => { setLoop((value) => !value); clearResult(); }} disabled={!file || processing}><span /></button>
            </div>

            <div className="estimate-row"><span>{frameCount} frames</span><span>{outputSize.width} × {outputSize.height || "—"} px</span><span>GIF</span></div>
          </div>
        </div>
      </section>

      <section className={`action-card ${result ? "with-result" : ""}`}>
        {error && <div className="error-message" role="alert"><span>!</span>{error}</div>}
        {processing ? (
          <div className="progress-area">
            <div className="progress-copy"><strong>{status}</strong><span>{progress}%</span></div>
            <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
            <button className="cancel-button" type="button" onClick={() => { cancelRef.current = true; if (jobIdRef.current) window.loopdrop.cancel(jobIdRef.current); }}>Cancel</button>
          </div>
        ) : result ? (
          <div className="result-layout">
            <div className="gif-preview"><img src={result.url} alt="Your converted GIF preview" /></div>
            <div className="result-copy">
              <p className="eyebrow">YOUR LOOP IS READY</p>
              <h2>Nice one.</h2>
              <p>{result.frames} frames · {result.width} × {result.height} px · {formatSize(result.size)}<small className="download-note">Saved automatically to Downloads</small></p>
              <div className="result-actions">
                <button className="download-button" type="button" onClick={() => window.loopdrop.showInFolder(result.outputPath)}>Show in folder <span>↗</span></button>
                <button type="button" onClick={() => { clearResult(); setStatus("Ready to convert"); }}>Adjust</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="convert-row">
            <div><strong>{status}</strong><span>{file ? `${frameCount} frames will be created locally` : "Add a video to unlock conversion"}</span></div>
            <button className="convert-button" type="button" onClick={convert} disabled={!file || !duration}>Create my GIF <span>→</span></button>
          </div>
        )}
      </section>

      <footer><span>loopdrop</span><p>No uploads · No watermark · No account</p><span>DESKTOP EDITION</span></footer>
    </main>
  );
}

export default function Home() {
  const miniMode = new URLSearchParams(window.location.search).get("mode") === "mini";
  return miniMode ? <MiniApp /> : <FullApp />;
}
