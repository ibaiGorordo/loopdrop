export type SizePreset = "w320" | "w480" | "w640" | "h720" | "h1080" | "original";
export type ClipPreset = "3" | "5" | "10" | "full";
export type MiniQuality = "compact" | "balanced" | "hd";

export type AppSettings = {
  version: 1;
  fullClipPreset: ClipPreset;
  miniClipPreset: ClipPreset;
  miniQuality: MiniQuality;
  sizePreset: SizePreset;
  fps: 8 | 12 | 15 | 20;
  colors: 64 | 128 | 192 | 256;
  loop: boolean;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  version: 1,
  fullClipPreset: "10",
  miniClipPreset: "5",
  miniQuality: "balanced",
  sizePreset: "w480",
  fps: 12,
  colors: 128,
  loop: true,
};

export const SETTINGS_STORAGE_KEY = "loopdrop.settings.v1";

const clipPresets = new Set<ClipPreset>(["3", "5", "10", "full"]);
const miniQualities = new Set<MiniQuality>(["compact", "balanced", "hd"]);
const sizePresets = new Set<SizePreset>(["w320", "w480", "w640", "h720", "h1080", "original"]);
const frameRates = new Set<AppSettings["fps"]>([8, 12, 15, 20]);
const colorCounts = new Set<AppSettings["colors"]>([64, 128, 192, 256]);

export function normalizeAppSettings(value: unknown): AppSettings {
  const candidate = value && typeof value === "object" ? value as Partial<AppSettings> : {};
  return {
    version: 1,
    fullClipPreset: clipPresets.has(candidate.fullClipPreset as ClipPreset) ? candidate.fullClipPreset as ClipPreset : DEFAULT_APP_SETTINGS.fullClipPreset,
    miniClipPreset: clipPresets.has(candidate.miniClipPreset as ClipPreset) ? candidate.miniClipPreset as ClipPreset : DEFAULT_APP_SETTINGS.miniClipPreset,
    miniQuality: miniQualities.has(candidate.miniQuality as MiniQuality) ? candidate.miniQuality as MiniQuality : DEFAULT_APP_SETTINGS.miniQuality,
    sizePreset: sizePresets.has(candidate.sizePreset as SizePreset) ? candidate.sizePreset as SizePreset : DEFAULT_APP_SETTINGS.sizePreset,
    fps: frameRates.has(candidate.fps as AppSettings["fps"]) ? candidate.fps as AppSettings["fps"] : DEFAULT_APP_SETTINGS.fps,
    colors: colorCounts.has(candidate.colors as AppSettings["colors"]) ? candidate.colors as AppSettings["colors"] : DEFAULT_APP_SETTINGS.colors,
    loop: typeof candidate.loop === "boolean" ? candidate.loop : DEFAULT_APP_SETTINGS.loop,
  };
}

export function loadAppSettings(): AppSettings {
  if (typeof window === "undefined") return { ...DEFAULT_APP_SETTINGS };
  try {
    const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    return stored ? normalizeAppSettings(JSON.parse(stored)) : { ...DEFAULT_APP_SETTINGS };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export function saveAppSettings(settings: AppSettings) {
  const normalized = normalizeAppSettings(settings);
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent("loopdrop:settings-changed", { detail: normalized }));
  return normalized;
}
