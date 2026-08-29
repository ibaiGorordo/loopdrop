type ConversionRequest = {
  jobId: string;
  inputPath: string;
  sourceName: string;
  start: number;
  duration: number;
  fps: number;
  width: number;
  height: number;
  colors: number;
  loop: boolean;
};

type ConversionResult = {
  outputPath: string;
  outputName: string;
  previewUrl: string;
  size: number;
};

type ConversionProgress = {
  jobId: string;
  percent: number;
  message: string;
};

type LocalVideo = {
  inputPath: string;
  name: string;
  size: number;
  previewUrl: string;
  duration: number;
  width: number;
  height: number;
};

interface Window {
  loopdrop: {
    getPathForFile(file: File): string;
    convert(request: ConversionRequest): Promise<ConversionResult>;
    cancel(jobId: string): Promise<boolean>;
    showInFolder(path: string): Promise<void>;
    chooseVideo(): Promise<LocalVideo | null>;
    inspectVideo(inputPath: string): Promise<LocalVideo>;
    getMiniVideo(): Promise<LocalVideo | null>;
    rememberMiniVideo(inputPath: string): Promise<LocalVideo | null>;
    clearMiniVideo(): Promise<boolean>;
    hideMini(): Promise<void>;
    openFullApp(): Promise<void>;
    onOpenSettings(callback: () => void): () => void;
    onMiniFile(callback: (file: LocalVideo) => void): () => void;
    onProgress(callback: (progress: ConversionProgress) => void): () => void;
  };
}
