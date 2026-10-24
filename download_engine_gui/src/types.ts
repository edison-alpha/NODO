export type JobStatus =
  | "queued"
  | "downloading"
  | "paused"
  | "completed"
  | "cancelled"
  | "error"
  /** Was running when the app last closed, so it has no engine handle anymore. */
  | "interrupted";

export type FileCategory = "compressed" | "documents" | "video" | "audio" | "programs" | "other";

export interface Job {
  id: string;
  url: string;
  name: string;
  outputPath: string;
  sizeBytes: number;
  downloadedBytes: number;
  speedBytes: number;
  segments: number;
  limit: string;
  status: JobStatus;
  category: FileCategory;
  supportsRange: boolean | null;
  error: string | null;
  createdAt: number;
  lastTick: { time: number; downloaded: number } | null;
  /**
   * The user named this file themselves, so the probe must not rename it.
   * Without this a `Content-Disposition` would quietly overrule the name they
   * typed into the form.
   */
  nameFromUser: boolean;
  /** "media" jobs are video pages saved through yt-dlp; absent means a plain file. */
  kind?: "file" | "media";
  media?: MediaSpec;
  /** A passing note from yt-dlp ("Merging video and audio…"), cleared when the job moves on. */
  statusText?: string;
}

/** What a media job needs to run again: which quality, and where it lands. */
export interface MediaSpec {
  /** `best`, `v1080`, `m4a` or `mp3`, as the extension offered it. */
  choice: string;
  /** The quality as shown, e.g. "1080p" or "Audio only · MP3". */
  label: string;
  /** Folder yt-dlp writes into; the file name comes from the video title. */
  dir: string;
}

export interface NewJobInput {
  url: string;
  /** Folder to save into. Empty falls back to `settings.defaultOutputDir`. */
  outputPath: string;
  /**
   * File name the user typed. Empty means "work it out": the URL supplies a
   * placeholder and the server's suggestion replaces it once the probe lands.
   */
  fileName: string;
  segments: number;
  limit: string;
  startInSec: number;
  forceStart: boolean;
}

export interface AppSettings {
  defaultSegments: number;
  defaultLimit: string;
  defaultOutputDir: string;
  concurrency: number;
  maxRetries: number;
  userAgent: string;
  /** Watch the clipboard for links. Off by default — see the GUI README. */
  clipboardMonitor: boolean;
  /** Listen for links from the browser extension. Off by default: it opens a port. */
  browserBridge: boolean;
  /** Floating island at the top of the screen while downloads run. */
  islandEnabled: boolean;
  /** Speed, storage and queue widgets beside the list. */
  showWidgets: boolean;
  /** Translucent window with the desktop blurred behind it. */
  glassEnabled: boolean;
  /** How opaque the panels are on top of the blur, 0.4 to 1. Lower than 0.4 fails text contrast. */
  glassOpacity: number;
  glassEffect: GlassEffect;
  /**
   * Bumped when a default changes in a way saved settings should pick up.
   * 2: concurrency default went from 1 to 3.
   */
  settingsVersion?: number;
  /** Which Overview cards show, in order. Missing means the default set. */
  overview?: OverviewItem[];
}

export type OverviewWidget = "queue" | "speed" | "storage" | "recent";

export interface OverviewItem {
  id: OverviewWidget;
  visible: boolean;
}

/** "system" follows the Windows light/dark setting, and keeps following it while the app runs. */
export type ThemeMode = "light" | "dark" | "system";

/** Which Windows backdrop sits behind the window. Mica needs Windows 11. */
export type GlassEffect = "acrylic" | "mica";

/** One download as the island sees it: only what it draws, nothing credential-bearing. */
export interface IslandJob {
  id: string;
  name: string;
  category: FileCategory;
  status: JobStatus;
  pct: number;
  speed: number;
  downloaded: number;
  size: number;
}

/** Snapshot the main window pushes to the island window. */
export interface IslandState {
  enabled: boolean;
  /** Downloading or paused jobs. */
  jobs: IslandJob[];
  queued: number;
  totalSpeed: number;
}

/** A job that just ended, so the island can say so before it hides again. */
export interface IslandFlash {
  kind: "done" | "failed";
  name: string;
}

export type IslandAction =
  | { type: "pause" | "resume"; id: string }
  | { type: "pauseAll" | "resumeAll" | "paste" | "openMain" };

export const ISLAND_STATE_EVENT = "island-state";
export const ISLAND_FLASH_EVENT = "island-flash";
export const ISLAND_ACTION_EVENT = "island-action";

/** Where the browser extension should connect, and the token it must present. */
export interface BridgeInfo {
  port: number;
  token: string;
  running: boolean;
}

/**
 * Extra request headers a job needs to resolve — a session `Cookie`, a
 * `Referer` the server checks. Only ever supplied by the browser extension.
 */
export type JobHeaders = Record<string, string>;

/** Live per-segment progress, polled from the engine while a job runs. */
export interface SegmentProgress {
  index: number;
  downloaded: number;
  total: number;
}

/** What a HEAD request told the engine about a URL, before anything is saved. */
export interface ProbeResult {
  total_size: number;
  supports_range: boolean;
  /**
   * The server's preferred file name, from `Content-Disposition`.
   *
   * Already sanitised by the engine into a single path component — it cannot
   * contain a separator or `..` — so it is safe to join onto the output folder.
   */
  suggested_filename: string | null;
}

/** How much of a partial file is already on disk and can be continued. */
export interface ResumeInfo {
  downloaded: number;
  total: number;
}

export type JobResult = { status: "completed"; path: string } | { status: "cancelled" };

export type MediaResult = { status: "completed"; path: string } | { status: "paused" } | { status: "cancelled" };

export interface MediaToolsStatus {
  ytdlp: boolean;
  ffmpeg: boolean;
}

/**
 * The clipboard has no change event, so it has to be polled. Shared with the
 * settings copy, so what the user is told matches what actually happens.
 */
export const CLIPBOARD_POLL_MS = 1500;

export const SPEED_LIMIT_OPTIONS = [
  { value: "", label: "Unlimited" },
  { value: "500KB", label: "500 KB/s" },
  { value: "2MB", label: "2 MB/s" },
  { value: "10MB", label: "10 MB/s" },
] as const;
