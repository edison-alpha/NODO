import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { Effect, getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import "./App.css";
import { CLIPBOARD_POLL_MS, ISLAND_ACTION_EVENT, ISLAND_FLASH_EVENT, ISLAND_STATE_EVENT, SPEED_LIMIT_OPTIONS } from "./types";
import type { AppSettings, FileCategory, IslandAction, IslandFlash, IslandState, Job, JobHeaders, JobResult, JobStatus, MediaResult, MediaToolsStatus, NewJobInput, ProbeResult, ResumeInfo, ThemeMode } from "./types";
import { baseName, calculateEta, detectCategory, formatBytes, joinPath, nameFromUrl, progressPercent, uniqueOutputPath } from "./lib/format";
import { loadState, saveState } from "./lib/persistence";
import { notifyDownloadComplete, notifyDownloadFailed } from "./lib/notifications";
import { copyToClipboard, readClipboardText, revealInFolder } from "./lib/jobActions";
import { setBridgeEnabled } from "./lib/bridge";
import { defaultDownloadDir } from "./lib/paths";
import { dragHasText, extractUrls, findByUrl, isHttpUrl } from "./lib/urls";
import { barColor, categoryIcon, formatSpeed, hostOf } from "./lib/ui";
import NewDownloadModal from "./components/NewDownloadModal";
import SettingsModal from "./components/SettingsModal";
import InspectorDrawer from "./components/InspectorDrawer";
import FileThumb from "./components/FileThumb";
import MediaToolsDialog from "./components/MediaToolsDialog";
import ShortcutsDialog from "./components/ShortcutsDialog";
import ReportIssueDialog from "./components/ReportIssueDialog";
import type { SettingsPage } from "./components/SettingsModal";
import Select from "./components/Select";
import SearchBox from "./components/SearchBox";
import { ContextMenu } from "./components/Menu";
import type { MenuItem } from "./components/Menu";
import { PRIMARY_BTN, SECONDARY_BTN } from "./components/controls";
import { Switch } from "./components/Sheet";
import Widgets, { normalizeOverview, SPEED_HISTORY_LEN } from "./components/Widgets";
import Icon from "./components/Icon";
import type { IconName } from "./lib/icon-data";

const appWindow = getCurrentWindow();

const DEFAULT_SETTINGS: AppSettings = {
  defaultSegments: 8,
  defaultLimit: "",
  defaultOutputDir: "",
  concurrency: 3,
  maxRetries: 5,
  userAgent: "",
  clipboardMonitor: false,
  browserBridge: false,
  islandEnabled: true,
  showWidgets: true,
  glassEnabled: true,
  glassOpacity: 0.7,
  glassEffect: "acrylic",
  settingsVersion: 2,
};

/** Interrupted and cancelled only get a row when something is actually in them. */
const STATUS_FILTERS: { key: "all" | JobStatus; label: string; icon: IconName; hideWhenEmpty?: boolean }[] = [
  { key: "all", label: "Downloads", icon: "download" },
  { key: "downloading", label: "Downloading", icon: "downloading" },
  { key: "queued", label: "Queue", icon: "queue" },
  { key: "paused", label: "Paused", icon: "pause" },
  { key: "completed", label: "Completed", icon: "completed" },
  { key: "error", label: "Failed", icon: "failed" },
  { key: "interrupted", label: "Interrupted", icon: "interrupted", hideWhenEmpty: true },
  { key: "cancelled", label: "Cancelled", icon: "cancelled", hideWhenEmpty: true },
];

const CATEGORY_FILTERS: { key: FileCategory; label: string }[] = [
  { key: "video", label: "Video" },
  { key: "audio", label: "Audio" },
  { key: "documents", label: "Documents" },
  { key: "compressed", label: "Archives" },
  { key: "programs", label: "Apps" },
  { key: "other", label: "Other" },
];

const ACTIVE_STATUSES: JobStatus[] = ["downloading", "paused"];

/** Stopped one way or another, so there is something to re-queue. */
const RETRYABLE_STATUSES: JobStatus[] = ["error", "cancelled", "completed", "interrupted"];

/** Longest a change may sit unsaved while downloads keep firing progress events. */
const SAVE_INTERVAL_MS = 3000;
/** Quiet period after the last change before saving, when nothing is running. */
const SAVE_DEBOUNCE_MS = 600;
/** How often the island is sent a fresh snapshot while it is enabled. */
const ISLAND_PUSH_MS = 500;

const WIN_BTN = "grid h-8 w-8 place-items-center rounded-full text-ink-3 transition-colors hover:bg-raised hover:text-ink";
type ViewMode = "list" | "grid";
const VIEW_KEY = "download-view";

function readView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

const TOP_PILL ="press grid h-10 flex-1 place-items-center rounded-full bg-raised text-ink-2 transition-colors hover:text-ink";
const NAV_ITEM = "flex h-10 w-full items-center gap-3 rounded-2xl px-3 text-left text-[13px] transition-colors";
const NAV_ACTIVE = "bg-raised font-medium text-ink";
const NAV_IDLE = "text-ink-2 hover:bg-raised/60 hover:text-ink";
const PILL_BTN = "press inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-xs font-medium text-ink-2 transition-colors hover:bg-sheet-hover hover:text-ink";
/** One line under the progress bar, saying what the job is doing right now. */
function metaLine(job: Job): { text: string; tone: "plain" | "ok" | "danger" | "warn" } {
  const done = formatBytes(job.downloadedBytes);
  const total = job.sizeBytes > 0 ? formatBytes(job.sizeBytes) : "unknown size";
  switch (job.status) {
    case "downloading": {
      if (job.statusText) return { text: job.statusText, tone: "plain" };
      const eta = calculateEta(job);
      const speed = job.speedBytes > 0 ? ` · ${formatSpeed(job.speedBytes)}` : " · connecting";
      return { text: `${done} of ${total}${speed}${eta !== "-" ? ` · ${eta} left` : ""}`, tone: "plain" };
    }
    case "paused":
      return { text: `Paused · ${done} of ${total}`, tone: "warn" };
    case "queued":
      return { text: "Waiting for a free slot", tone: "plain" };
    case "completed":
      return { text: `Completed · ${total}`, tone: "ok" };
    case "cancelled":
      return { text: `Cancelled · ${done} downloaded`, tone: "plain" };
    case "interrupted":
      return { text: `Interrupted when the app closed · ${done} saved, can resume`, tone: "warn" };
    case "error":
      return { text: job.error ? `Failed · ${job.error}` : "Failed", tone: "danger" };
  }
}

const TONE_CLASS = {
  plain: "text-ink-2",
  ok: "text-ok-text",
  danger: "text-danger-text",
  warn: "text-ink-2",
} as const;

/**
 * Folds a probe result into a job: its size, whether it can be segmented, and
 * the file name the server would rather we used.
 *
 * The rename is deliberately narrow, and skipped when:
 * - the user named the file themselves — their choice outranks the server's;
 * - there is no output folder, since the engine then derives the name from the
 *   URL itself and the label has to keep matching what it will write;
 * - the download is no longer merely queued, because by then the engine has
 *   created and preallocated the file at the old path and the bytes are landing
 *   there. Renaming the job would only lose track of the file.
 *
 * `uniqueOutputPath` still applies, so a suggestion that happens to land on
 * another job's target gets a " (1)" instead of two jobs writing one file.
 *
 * A failed probe is not treated as "no Range support unknown": it reports
 * `supportsRange: false`, which is what the old inline handler did.
 */
function applyProbe(job: Job, result: ProbeResult | null, outputDir: string, otherPaths: ReadonlySet<string>): Job {
  if (!result) return { ...job, supportsRange: false };

  const probed: Job = { ...job, sizeBytes: result.total_size || job.sizeBytes, supportsRange: result.supports_range };

  const suggested = result.suggested_filename;
  if (!suggested || job.nameFromUser || !outputDir || job.status !== "queued" || job.downloadedBytes > 0) return probed;

  // Safe to join: the engine has already reduced this to a single path
  // component, so it cannot climb out of `outputDir`.
  const outputPath = uniqueOutputPath(joinPath(outputDir, suggested), otherPaths);
  if (outputPath === job.outputPath) return probed;

  const name = baseName(outputPath);
  return { ...probed, outputPath, name, category: detectCategory(name) };
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The Windows app theme, live: WebView2 reports it through prefers-color-scheme. */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia(DARK_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return dark;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

function App() {
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const systemDark = useSystemDark();
  const dark = theme === "system" ? systemDark : theme === "dark";
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [globalLimit, setGlobalLimit] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | JobStatus>("all");
  const [categoryFilter, setCategoryFilter] = useState<"all" | FileCategory>("all");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [newDownloadOpen, setNewDownloadOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Row whose "more actions" menu is open. */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [view, setView] = useState<ViewMode>(readView);
  const [mediaToolsOpen, setMediaToolsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  /** Where the sidebar's Settings menu opens: the top-left of its button. */
  const [settingsMenu, setSettingsMenu] = useState<{ x: number; y: number } | null>(null);
  /** The page Settings opens on; the Overview's Customize button sends it to Appearance. */
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("downloads");
  /** Total speed, one sample per second, newest last. Feeds the speed widget. */
  const [speedHistory, setSpeedHistory] = useState<number[]>(() => Array(SPEED_HISTORY_LEN).fill(0));
  const startingRef = useRef<Set<string>>(new Set());
  const [restored, setRestored] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** Anchor for shift-click range selection. */
  const lastClickedRef = useRef<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  /** Seeds the new-download form when a link is dropped onto the window. */
  const [pendingUrl, setPendingUrl] = useState("");
  /** Short-lived message for things that happen without a dialog open. */
  const [notice, setNotice] = useState("");
  /** Link spotted in the clipboard, waiting to be accepted or dismissed. */
  const [clipboardUrl, setClipboardUrl] = useState("");
  /**
   * Per-job request headers, kept out of `jobs` on purpose.
   *
   * These arrive from the browser extension and contain session cookies.
   * `jobs` is written to `app-state.json` as plain text, so putting them there
   * would mean parking live credentials on disk for as long as the job row
   * survives. Holding them in memory means a bridge job that outlives a
   * restart retries without its cookie and fails — which is the honest
   * outcome: the user re-sends it from the browser and gets a fresh one.
   */
  const jobHeadersRef = useRef<Map<string, JobHeaders>>(new Map());

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  // The panels only turn translucent once Windows has actually accepted the
  // backdrop. Without it the transparent window would show the desktop sharp,
  // behind text that was tuned for a blurred, tinted backdrop.
  const [glassActive, setGlassActive] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("glass", glassActive);
    root.style.setProperty("--glass", String(settings.glassOpacity));
  }, [glassActive, settings.glassOpacity]);

  // The tint sits under the panels and keeps text readable over a bright wallpaper.
  useEffect(() => {
    let active = true;
    const tint: [number, number, number, number] = dark ? [12, 13, 15, 160] : [246, 247, 249, 170];
    const apply = async () => {
      if (!settings.glassEnabled) {
        await appWindow.clearEffects().catch(() => {});
        if (active) setGlassActive(false);
        return;
      }
      const wanted = settings.glassEffect === "mica" ? Effect.Mica : Effect.Acrylic;
      try {
        await appWindow.setEffects({ effects: [wanted], color: tint });
        if (active) setGlassActive(true);
      } catch {
        // Mica is Windows 11 only; fall back to acrylic before giving up.
        try {
          await appWindow.setEffects({ effects: [Effect.Acrylic], color: tint });
          if (active) setGlassActive(true);
        } catch {
          if (active) {
            setGlassActive(false);
            setNotice("Glass effect is not supported on this system. Switched back to solid.");
          }
        }
      }
    };
    void apply();
    return () => {
      active = false;
    };
  }, [settings.glassEnabled, settings.glassEffect, dark]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Pull the last session back in before anything else touches state.
  useEffect(() => {
    let active = true;
    loadState()
      .then(async (saved) => {
        if (!active) return;
        if (isThemeMode(saved?.theme)) setTheme(saved.theme);
        else if (typeof saved?.dark === "boolean") setTheme(saved.dark ? "dark" : "light");
        if (typeof saved?.globalLimit === "string") setGlobalLimit(saved.globalLimit);
        if (saved?.jobs) setJobs(saved.jobs);

        const restoredSettings = { ...DEFAULT_SETTINGS, ...saved?.settings, settingsVersion: DEFAULT_SETTINGS.settingsVersion };
        // Settings saved before version 2 hold the old default of one file at
        // a time, which queues everything behind a single download. Nobody
        // picked that on purpose before the default changed, so move it up.
        if ((saved?.settings?.settingsVersion ?? 1) < 2 && restoredSettings.concurrency === 1) {
          restoredSettings.concurrency = DEFAULT_SETTINGS.concurrency;
        }
        // An empty output dir means files land in the process working
        // directory, which is wherever the app happened to be launched from —
        // effectively "lost". Fill it in on first run instead.
        if (!restoredSettings.defaultOutputDir) {
          const fallback = await defaultDownloadDir();
          if (!active) return;
          restoredSettings.defaultOutputDir = fallback;
        }
        setSettings(restoredSettings);
      })
      .finally(() => {
        if (active) setRestored(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // Save on change, but throttled rather than purely debounced: progress events
  // arrive several times a second, and a plain debounce would keep resetting
  // its own timer so nothing ever hit the disk while a download was running.
  const lastSaveRef = useRef(0);
  useEffect(() => {
    if (!restored) return;
    const sinceLastSave = Date.now() - lastSaveRef.current;
    const delay = sinceLastSave > SAVE_INTERVAL_MS ? 0 : SAVE_DEBOUNCE_MS;
    const timer = window.setTimeout(() => {
      lastSaveRef.current = Date.now();
      saveState({ dark, theme, globalLimit, settings, jobs });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [restored, dark, theme, globalLimit, settings, jobs]);

  // A restored limit lives only in the UI until the engine is told about it.
  useEffect(() => {
    if (!restored || !globalLimit) return;
    invoke("set_global_speed_limit", { limit: globalLimit }).catch(() => {});
  }, [restored, globalLimit]);

  // The engine builds its HTTP client per call, so it needs the current UA.
  useEffect(() => {
    invoke("set_user_agent", { userAgent: settings.userAgent || null }).catch(() => {});
  }, [settings.userAgent]);

  // Progress events, tagged per job id.
  useEffect(() => {
    const unlisten = listen<{ job_id: string; downloaded: number; total: number }>("job-progress", (event) => {
      const { job_id, downloaded, total } = event.payload;
      setJobs((prev) =>
        prev.map((j) => {
          if (j.id !== job_id) return j;
          const now = Date.now();
          let speedBytes = j.speedBytes;
          let lastTick = j.lastTick;
          if (j.lastTick) {
            const dt = (now - j.lastTick.time) / 1000;
            if (dt > 0.2) {
              speedBytes = Math.max(0, (downloaded - j.lastTick.downloaded) / dt);
              lastTick = { time: now, downloaded };
            }
          } else {
            lastTick = { time: now, downloaded };
          }
          // Bytes moving means any "reading page" or "merging" note is out of date.
          return { ...j, downloadedBytes: downloaded, sizeBytes: total || j.sizeBytes, speedBytes, lastTick, statusText: undefined };
        }),
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{ job_id: string; text: string }>("media-status", (event) => {
      const { job_id, text } = event.payload;
      setJobs((prev) => prev.map((j) => (j.id === job_id ? { ...j, statusText: text } : j)));
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const beginMediaJob = useCallback(async (job: Job) => {
    const spec = job.media;
    setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: "downloading", error: null, lastTick: null, speedBytes: 0, statusText: "Reading video page…" } : j)));
    try {
      const result = await invoke<MediaResult>("media_download", {
        jobId: job.id,
        url: job.url,
        choice: spec?.choice ?? "best",
        outputDir: spec?.dir ?? "",
        limit: job.limit || null,
        headers: jobHeadersRef.current.get(job.id) ?? null,
      });
      setJobs((prev) =>
        prev.map((j) => {
          if (j.id !== job.id) return j;
          if (result.status === "paused") return { ...j, status: "paused", speedBytes: 0, statusText: undefined };
          if (result.status === "cancelled") return { ...j, status: "cancelled", speedBytes: 0, statusText: undefined };
          // yt-dlp names the file from the video's title; the row takes that name now.
          const name = baseName(result.path);
          return { ...j, status: "completed", outputPath: result.path, name, category: detectCategory(name), downloadedBytes: j.sizeBytes || j.downloadedBytes, speedBytes: 0, statusText: undefined };
        }),
      );
      if (result.status === "completed") {
        notifyDownloadComplete(baseName(result.path));
        void emit(ISLAND_FLASH_EVENT, { kind: "done", name: baseName(result.path) } satisfies IslandFlash);
      }
    } catch (err) {
      const missing = String(err) === "tools-missing";
      const message = missing ? "Video support isn't installed yet" : String(err);
      setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: "error", error: message, speedBytes: 0, statusText: undefined } : j)));
      if (missing) setMediaToolsOpen(true);
      else {
        notifyDownloadFailed(job.name, message);
        void emit(ISLAND_FLASH_EVENT, { kind: "failed", name: job.name } satisfies IslandFlash);
      }
    } finally {
      startingRef.current.delete(job.id);
    }
  }, []);

  const beginJob = useCallback(
    async (job: Job) => {
      if (job.kind === "media") return beginMediaJob(job);
      setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: "downloading", error: null, lastTick: null, speedBytes: 0 } : j)));
      try {
        const result = await invoke<JobResult>("start_download", {
          jobId: job.id,
          url: job.url,
          output: job.outputPath || null,
          segments: job.segments,
          limit: job.limit || null,
          retries: settings.maxRetries,
          headers: jobHeadersRef.current.get(job.id) ?? null,
        });
        setJobs((prev) =>
          prev.map((j) => {
            if (j.id !== job.id) return j;
            if (result.status === "cancelled") {
              return { ...j, status: "cancelled", speedBytes: 0 };
            }
            return { ...j, status: "completed", outputPath: result.path, downloadedBytes: j.sizeBytes || j.downloadedBytes, speedBytes: 0 };
          }),
        );
        if (result.status === "completed") {
          notifyDownloadComplete(job.name);
          void emit(ISLAND_FLASH_EVENT, { kind: "done", name: job.name } satisfies IslandFlash);
        }
      } catch (err) {
        setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: "error", error: String(err), speedBytes: 0 } : j)));
        notifyDownloadFailed(job.name, String(err));
        void emit(ISLAND_FLASH_EVENT, { kind: "failed", name: job.name } satisfies IslandFlash);
      } finally {
        startingRef.current.delete(job.id);
      }
    },
    [settings.maxRetries, beginMediaJob],
  );

  // Scheduler: whenever a concurrency slot is free, start the next queued job.
  // Paused jobs still hold their slot, since their connection is only parked.
  useEffect(() => {
    // Jobs still being started count too, or a burst of adds could overshoot the limit.
    const activeCount = jobs.filter((j) => ACTIVE_STATUSES.includes(j.status) || startingRef.current.has(j.id)).length;
    if (activeCount >= settings.concurrency) return;
    const next = jobs.find((j) => j.status === "queued" && !startingRef.current.has(j.id));
    if (!next) return;
    startingRef.current.add(next.id);
    beginJob(next);
  }, [jobs, settings.concurrency, beginJob]);

  async function probeJob(job: Job): Promise<ProbeResult | null> {
    try {
      // The probe needs the same headers the download will use: without the
      // cookie, a gated link answers about a login page and the size shown
      // would describe the wrong response entirely.
      return await invoke<ProbeResult>("probe_url", {
        url: job.url,
        headers: jobHeadersRef.current.get(job.id) ?? null,
      });
    } catch {
      return null;
    }
  }

  /**
   * `takenPaths` lets a batch stay collision-free: `jobs` doesn't update
   * between synchronous calls, so the caller threads one growing set through
   * them instead of re-reading state that is still stale.
   */
  function handleCreateJob(input: NewJobInput, takenPaths?: Set<string>, headers?: JobHeaders) {
    const id = crypto.randomUUID();
    // Registered before the probe fires, since that is the first request to go
    // out and it needs them too.
    if (headers && Object.keys(headers).length > 0) jobHeadersRef.current.set(id, headers);
    const outputDir = input.outputPath || settings.defaultOutputDir;
    const taken = takenPaths ?? new Set(jobs.map((j) => j.outputPath).filter(Boolean));
    // A name the user typed is confined to a file name — a path they entered
    // here would otherwise nest the file somewhere other than the folder shown
    // right above it in the form.
    const typedName = baseName(input.fileName);
    // The URL name is only a placeholder when the user left the name blank:
    // the probe replaces it with the server's own, which is the whole point for
    // a link like "/download?id=84213".
    const fileName = typedName || nameFromUrl(input.url);
    const outputPath = outputDir ? uniqueOutputPath(joinPath(outputDir, fileName), taken) : "";
    if (outputPath) taken.add(outputPath);
    // Without a folder the engine picks the file name itself, so the label
    // falls back to the name we derived rather than a path.
    const name = outputPath ? baseName(outputPath) : fileName;
    const baseJob: Job = {
      id,
      url: input.url,
      name,
      outputPath,
      sizeBytes: 0,
      downloadedBytes: 0,
      speedBytes: 0,
      segments: input.segments,
      limit: input.limit,
      status: "queued",
      category: detectCategory(name),
      supportsRange: null,
      error: null,
      createdAt: Date.now(),
      lastTick: null,
      nameFromUser: typedName.length > 0,
    };

    const addAndMaybeStart = async () => {
      // The probe gets to decide the final name, and starting the download
      // settles it for good — the engine creates and preallocates the output
      // file, and a rename after that would just lose track of it. So the
      // scheduler is held off until the probe has answered, using the same
      // latch it already honours. Taken before the job is visible to it.
      startingRef.current.add(id);
      setJobs((prev) => [baseJob, ...prev]);
      const result = await probeJob(baseJob);

      // Removed while the probe was in flight: nothing left to correct, and
      // re-adding it through `setJobs` would resurrect a deleted row.
      if (!jobsRef.current.some((j) => j.id === id)) {
        startingRef.current.delete(id);
        return;
      }

      // `jobsRef` rather than `jobs`: this runs a network round trip after the
      // render that added the job, so the ref is current where the closed-over
      // `jobs` is a snapshot from before it existed.
      const current = jobsRef.current.find((j) => j.id === id) ?? baseJob;
      const otherPaths = new Set(
        jobsRef.current
          .filter((j) => j.id !== id)
          .map((j) => j.outputPath)
          .filter(Boolean),
      );
      const probed = applyProbe(current, result, outputDir, otherPaths);

      // Released before the state update, not after: the scheduler re-checks on
      // the render that update triggers, and a hold still set at that point
      // would leave the job sitting in the queue with nothing left to wake it.
      if (!input.forceStart) startingRef.current.delete(id);
      setJobs((prev) => prev.map((j) => (j.id === id ? probed : j)));
      // Handed the probed job, so the engine is told the corrected path rather
      // than the URL-derived one it has just replaced.
      if (input.forceStart) beginJob(probed);
    };

    if (input.startInSec > 0) {
      window.setTimeout(() => void addAndMaybeStart(), input.startInSec * 1000);
    } else {
      void addAndMaybeStart();
    }
  }

  /**
   * Queues a video page for yt-dlp. The name shown until it finishes is the
   * page title plus the extension the chosen quality will produce; yt-dlp's
   * own sanitised name replaces it on completion.
   */
  function createMediaJob(url: string, choice: string, label: string, title: string, headers: JobHeaders) {
    const id = crypto.randomUUID();
    if (Object.keys(headers).length > 0) jobHeadersRef.current.set(id, headers);
    const ext = choice === "mp3" ? "mp3" : choice === "m4a" ? "m4a" : "mp4";
    const clean = (title || hostOf(url)).replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 150) || "video";
    const name = `${clean}.${ext}`;
    const job: Job = {
      id,
      url,
      name,
      outputPath: "",
      sizeBytes: 0,
      downloadedBytes: 0,
      speedBytes: 0,
      segments: 1,
      limit: settings.defaultLimit,
      status: "queued",
      category: detectCategory(name),
      supportsRange: null,
      error: null,
      createdAt: Date.now(),
      lastTick: null,
      nameFromUser: false,
      kind: "media",
      media: { choice, label: label || choice, dir: settings.defaultOutputDir },
    };
    setJobs((prev) => [job, ...prev]);
  }

  /** Once the tools are in, every video job that stopped for want of them goes again. */
  function onMediaToolsInstalled() {
    setMediaToolsOpen(false);
    setJobs((prev) => prev.map((j) => (j.kind === "media" && j.status === "error" && j.error === "Video support isn't installed yet" ? { ...j, status: "queued", error: null } : j)));
  }

  async function pauseJob(id: string) {
    const kind = jobsRef.current.find((j) => j.id === id)?.kind;
    try {
      // A video job is stopped outright; yt-dlp keeps its partial files and
      // continues from them when the job is started again.
      await invoke(kind === "media" ? "media_pause" : "pause_download", { jobId: id });
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: "paused", speedBytes: 0, lastTick: null } : j)));
    } catch (err) {
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, error: String(err) } : j)));
    }
  }

  async function resumeJob(id: string) {
    const media = jobsRef.current.find((j) => j.id === id && j.kind === "media");
    if (media) {
      startingRef.current.add(id);
      void beginMediaJob(media);
      return;
    }
    try {
      await invoke("resume_download", { jobId: id });
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: "downloading", lastTick: null } : j)));
    } catch (err) {
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, error: String(err) } : j)));
    }
  }

  async function cancelJob(id: string) {
    // The command resolves as soon as the signal lands; `start_download` then
    // settles the job as cancelled once the segments actually wind down.
    const job = jobsRef.current.find((j) => j.id === id);
    if (job?.kind === "media") {
      // A paused video job has no process left to stop.
      if (job.status === "paused") setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: "cancelled" } : j)));
      else await invoke("media_cancel", { jobId: id }).catch(() => {});
      return;
    }
    await invoke("cancel_download", { jobId: id }).catch(() => {});
  }

  /**
   * Re-queues a stopped job. The engine picks up a matching partial file on
   * its own, so this only has to get the UI's numbers right: ask what's
   * already on disk rather than blanking the bar and letting it snap back.
   */
  async function retryJob(id: string) {
    const job = jobs.find((j) => j.id === id);
    if (!job) return;

    const resumable = job.outputPath && job.kind !== "media"
      ? await invoke<ResumeInfo | null>("resume_info", { output: job.outputPath }).catch(() => null)
      : null;

    setJobs((prev) =>
      prev.map((j) =>
        j.id === id
          ? {
              ...j,
              status: "queued",
              error: null,
              downloadedBytes: resumable?.downloaded ?? 0,
              sizeBytes: resumable?.total ?? j.sizeBytes,
              speedBytes: 0,
              lastTick: null,
            }
          : j,
      ),
    );
  }

  function startAllQueued() {
    jobs
      .filter((j) => j.status === "queued")
      .forEach((j) => {
        if (!startingRef.current.has(j.id)) {
          startingRef.current.add(j.id);
          beginJob(j);
        }
      });
  }

  function pauseAllRunning() {
    jobs.filter((j) => j.status === "downloading").forEach((j) => pauseJob(j.id));
  }

  async function removeJob(id: string) {
    const job = jobs.find((j) => j.id === id);
    if (job && ACTIVE_STATUSES.includes(job.status)) {
      await cancelJob(id);
    }
    // A half-finished file is unusable on its own, so it goes with the job.
    // A completed one is the user's file and stays put.
    if (job && job.kind !== "media" && job.status !== "completed" && job.outputPath) {
      await invoke("discard_download", { output: job.outputPath }).catch(() => {});
    }
    setJobs((prev) => prev.filter((j) => j.id !== id));
    jobHeadersRef.current.delete(id);
    if (inspectedId === id) setInspectedId(null);
  }

  async function applyGlobalLimit(limit: string) {
    setGlobalLimit(limit);
    await invoke("set_global_speed_limit", { limit: limit || null }).catch(() => {});
  }

  async function browsePath(): Promise<string | null> {
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  }

  /**
   * Parks the app in the tray rather than ending it, so downloads survive.
   * Still flushes first, so the saved state matches what the user last saw.
   */
  async function closeWindow() {
    if (restored) await saveState({ dark, theme, globalLimit, settings, jobs });
    await appWindow.close();
  }

  /** The real exit, reached from the tray. Nothing else will flush after this. */
  async function quitApp() {
    if (restored) await saveState({ dark, theme, globalLimit, settings, jobs });
    await invoke("quit_app").catch(() => {});
  }

  // Tray entries act on the job list, which lives here rather than in the
  // engine. Routing them through a ref keeps the listeners pinned to the
  // latest handlers without re-subscribing on every progress tick.
  const trayActions = useRef({ startAll: () => {}, pauseAll: () => {}, quit: async () => {} });
  useEffect(() => {
    trayActions.current = { startAll: startAllQueued, pauseAll: pauseAllRunning, quit: quitApp };
  });

  useEffect(() => {
    const unlisten = Promise.all([
      listen("tray-start-all", () => trayActions.current.startAll()),
      listen("tray-pause-all", () => trayActions.current.pauseAll()),
      listen("tray-quit", () => void trayActions.current.quit()),
    ]);
    return () => {
      unlisten.then((fns) => fns.forEach((fn) => fn()));
    };
  }, []);

  function openNewDownload(url = "") {
    setPendingUrl(url);
    setNewDownloadOpen(true);
  }

  function closeNewDownload() {
    setNewDownloadOpen(false);
    setPendingUrl("");
  }

  const dropUrlsRef = useRef<(urls: string[]) => void>(() => {});
  useEffect(() => {
    dropUrlsRef.current = (urls) => {
      if (urls.length === 0) return;
      // A single link goes through the form, so an accidental drop can still
      // be reviewed or cancelled. A batch has no place in that form, so it
      // gets queued with the current defaults instead.
      if (urls.length === 1) {
        openNewDownload(urls[0]);
        return;
      }
      // Nobody reviews a batch, so duplicates are dropped silently rather than
      // queued twice; the count is reported instead.
      const fresh = urls.filter((url) => !findByUrl(jobs, url));
      const taken = new Set(jobs.map((j) => j.outputPath).filter(Boolean));
      fresh.forEach((url) =>
        handleCreateJob(
          {
            url,
            outputPath: "",
            // A dropped batch is never reviewed, so there is no name to take
            // from the user; the server's own is the best one available.
            fileName: "",
            segments: settings.defaultSegments,
            limit: settings.defaultLimit,
            startInSec: 0,
            forceStart: false,
          },
          taken,
        ),
      );
      const skipped = urls.length - fresh.length;
      setNotice(
        skipped === 0
          ? `${fresh.length} ${fresh.length === 1 ? "link" : "links"} added to the queue`
          : `${fresh.length} added, ${skipped} skipped because they are already in the list`,
      );
    };
  });

  // Dropped links are handled on `window` so the whole app area accepts them.
  // This only works because Tauri's own OS-level drag handler is disabled in
  // tauri.conf.json; with it on, WebView2 never forwards these DOM events.
  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer || !dragHasText(event.dataTransfer.types)) return;
      // Without preventDefault the browser refuses the drop outright — which
      // conveniently makes a file drag show a "not allowed" cursor by itself.
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragActive(true);
    };

    const onDragLeave = (event: DragEvent) => {
      // Inner elements fire this too, so only a null relatedTarget means the
      // pointer really left the window.
      if (event.relatedTarget === null) setDragActive(false);
    };

    const onDrop = (event: DragEvent) => {
      // Swallowed unconditionally, so a stray file drop can't make the webview
      // navigate away from the app.
      event.preventDefault();
      setDragActive(false);
      dropUrlsRef.current(extractUrls(event.dataTransfer));
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // Read inside the clipboard poll, which must not restart on every progress
  // tick the way a `jobs` dependency would make it.
  const jobsRef = useRef<Job[]>([]);
  useEffect(() => {
    jobsRef.current = jobs;
  });

  // One speed sample per second for the widget chart. Read from the ref so the
  // timer is set up once instead of restarting on every progress event.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const speed = jobsRef.current.filter((j) => j.status === "downloading").reduce((acc, j) => acc + j.speedBytes, 0);
      setSpeedHistory((prev) => [...prev.slice(1), speed]);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Feed the island window. It owns no job state of its own: it draws whatever
  // snapshot arrives here and sends clicks back as actions.
  useEffect(() => {
    let wasEnabled = false;
    const push = () => {
      if (!settings.islandEnabled) {
        // Tell it once that it is off, so it hides, then stay quiet.
        if (wasEnabled) void emit(ISLAND_STATE_EVENT, { enabled: false, jobs: [], queued: 0, totalSpeed: 0 } satisfies IslandState);
        wasEnabled = false;
        return;
      }
      wasEnabled = true;
      const all = jobsRef.current;
      const running = all.filter((j) => j.status === "downloading" || j.status === "paused");
      const snapshot: IslandState = {
        enabled: true,
        jobs: running.map((j) => ({
          id: j.id,
          name: j.name,
          category: j.category,
          status: j.status,
          pct: progressPercent(j),
          speed: j.status === "downloading" ? j.speedBytes : 0,
          downloaded: j.downloadedBytes,
          size: j.sizeBytes,
        })),
        queued: all.filter((j) => j.status === "queued").length,
        totalSpeed: running.reduce((acc, j) => acc + (j.status === "downloading" ? j.speedBytes : 0), 0),
      };
      void emit(ISLAND_STATE_EVENT, snapshot);
    };
    push();
    const timer = window.setInterval(push, ISLAND_PUSH_MS);
    return () => window.clearInterval(timer);
  }, [settings.islandEnabled]);

  // Clicks coming back from the island. Through a ref, like the tray actions,
  // so the listener is registered once and always calls the latest handlers.
  const islandActionRef = useRef<(action: IslandAction) => void>(() => {});
  useEffect(() => {
    islandActionRef.current = (action) => {
      switch (action.type) {
        case "pause":
          void pauseJob(action.id);
          break;
        case "resume":
          void resumeJob(action.id);
          break;
        case "pauseAll":
          pauseAllRunning();
          break;
        case "resumeAll":
          jobs.filter((j) => j.status === "paused").forEach((j) => void resumeJob(j.id));
          break;
        case "openMain":
          void invoke("show_main_window");
          break;
        case "paste":
          void (async () => {
            const text = (await readClipboardText()).trim();
            await invoke("show_main_window");
            openNewDownload(isHttpUrl(text) ? text : "");
          })();
          break;
      }
    };
  });

  useEffect(() => {
    const unlisten = listen<IslandAction>(ISLAND_ACTION_EVENT, (event) => islandActionRef.current(event.payload));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Clipboard monitor. Opt-in, and everything read is discarded unless it's a
  // link — nothing is stored and nothing leaves the process.
  useEffect(() => {
    // Pausing while the form is open keeps a link the user pastes in there
    // themselves from bouncing back as a suggestion.
    if (!settings.clipboardMonitor || newDownloadOpen) {
      setClipboardUrl("");
      return;
    }

    let cancelled = false;
    let lastSeen: string | null = null;

    const poll = async () => {
      const text = (await readClipboardText()).trim();
      if (cancelled || text === lastSeen) return;
      const seeding = lastSeen === null;
      lastSeen = text;
      // Whatever was already copied before the monitor started isn't a new
      // event, so the first read only establishes the baseline.
      if (seeding) return;
      if (!isHttpUrl(text) || findByUrl(jobsRef.current, text)) return;
      setClipboardUrl(text);
    };

    void poll();
    const timer = window.setInterval(() => void poll(), CLIPBOARD_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settings.clipboardMonitor, newDownloadOpen]);

  // Opening a port follows the setting, including turning it back off again.
  // A failure flips the switch back rather than leaving the UI claiming the
  // bridge is up while nothing is listening.
  useEffect(() => {
    if (!restored) return;
    let active = true;
    setBridgeEnabled(settings.browserBridge).catch((err) => {
      if (!active || !settings.browserBridge) return;
      setSettings((prev) => ({ ...prev, browserBridge: false }));
      setNotice(`Browser bridge failed to start: ${err}`);
    });
    return () => {
      active = false;
    };
  }, [restored, settings.browserBridge]);

  // Links handed over by the extension. Routed through a ref for the same
  // reason the drop handler is: the listener must not re-subscribe on every
  // progress tick.
  const bridgeDownloadRef = useRef<(url: string, headers: JobHeaders) => void>(() => {});
  useEffect(() => {
    bridgeDownloadRef.current = (url, headers) => {
      if (!isHttpUrl(url)) return;
      const existing = findByUrl(jobs, url);
      if (existing) {
        setNotice(`Link from the browser is already in the list: ${existing.name}`);
        return;
      }
      handleCreateJob(
        {
          url,
          outputPath: "",
          // The extension deliberately sends no name — see its README. The
          // server's `Content-Disposition`, sanitised by the engine, is what
          // fills the gap for a link whose URL carries no usable name.
          fileName: "",
          segments: settings.defaultSegments,
          limit: settings.defaultLimit,
          startInSec: 0,
          // Queued, not force-started: the scheduler begins it right away if a
          // slot is free, and respects the concurrency limit if not.
          forceStart: false,
        },
        undefined,
        headers,
      );
      setNotice(`Added from browser: ${nameFromUrl(url)}`);
    };
  });

  const bridgeMediaRef = useRef<(p: { url: string; choice: string; label: string; title: string; headers: JobHeaders }) => void>(() => {});
  useEffect(() => {
    bridgeMediaRef.current = ({ url, choice, label, title, headers }) => {
      createMediaJob(url, choice, label, title, headers ?? {});
      setNotice(`Video added from browser: ${title || hostOf(url)}`);
      // Asked up front rather than on the first failure, so the job can start the moment they're in.
      void invoke<MediaToolsStatus>("media_tools_status").then((s) => {
        if (!s.ytdlp || !s.ffmpeg) setMediaToolsOpen(true);
      });
    };
  });

  useEffect(() => {
    const unlisten = listen<{ url: string; choice: string; label: string; title: string; headers: JobHeaders }>("bridge-media", (event) => {
      bridgeMediaRef.current(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{ url: string; headers: JobHeaders }>("bridge-download", (event) => {
      bridgeDownloadRef.current(event.payload.url, event.payload.headers ?? {});
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const filteredJobs = useMemo(() => {
    const q = search.toLowerCase();
    return jobs.filter((j) => {
      const matchStatus = statusFilter === "all" || j.status === statusFilter;
      const matchCategory = categoryFilter === "all" || j.category === categoryFilter;
      const matchSearch = !q || j.name.toLowerCase().includes(q) || j.url.toLowerCase().includes(q);
      return matchStatus && matchCategory && matchSearch;
    });
  }, [jobs, statusFilter, categoryFilter, search]);

  // Selection is kept to what's actually on screen. Without this, a job could
  // stay selected after being deleted or filtered out of view, and a bulk
  // action would then hit something the user can't see.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(filteredJobs.map((j) => j.id));
      const next = new Set<string>();
      prev.forEach((id) => {
        if (visible.has(id)) next.add(id);
      });
      // Same contents means same state; returning a new Set would re-render
      // on every progress tick.
      return next.size === prev.size ? prev : next;
    });
  }, [filteredJobs]);

  function toggleSelect(id: string, shiftKey: boolean) {
    const ids = filteredJobs.map((j) => j.id);
    const to = ids.indexOf(id);
    const from = lastClickedRef.current ? ids.indexOf(lastClickedRef.current) : -1;
    const next = new Set(selectedIds);

    if (shiftKey && from !== -1 && to !== -1) {
      // Extend in the direction the clicked row is heading, the way file
      // managers do, rather than replacing the whole selection.
      const selecting = !selectedIds.has(id);
      const [start, end] = from < to ? [from, to] : [to, from];
      for (let i = start; i <= end; i++) {
        if (selecting) next.add(ids[i]);
        else next.delete(ids[i]);
      }
    } else if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }

    lastClickedRef.current = id;
    setSelectedIds(next);
  }

  function toggleSelectAll() {
    const allSelected = filteredJobs.length > 0 && filteredJobs.every((j) => selectedIds.has(j.id));
    lastClickedRef.current = null;
    setSelectedIds(allSelected ? new Set() : new Set(filteredJobs.map((j) => j.id)));
  }

  function clearSelection() {
    lastClickedRef.current = null;
    setSelectedIds(new Set());
  }

  const selectedJobs = useMemo(() => jobs.filter((j) => selectedIds.has(j.id)), [jobs, selectedIds]);

  // Each bulk action only touches the jobs it actually applies to, so a mixed
  // selection does the sensible thing instead of erroring on the rest.
  const bulk = useMemo(
    () => ({
      resumable: selectedJobs.filter((j) => j.status === "paused"),
      pausable: selectedJobs.filter((j) => j.status === "downloading"),
      stoppable: selectedJobs.filter((j) => ACTIVE_STATUSES.includes(j.status)),
      retryable: selectedJobs.filter((j) => RETRYABLE_STATUSES.includes(j.status)),
    }),
    [selectedJobs],
  );

  async function bulkResume() {
    await Promise.all(bulk.resumable.map((j) => resumeJob(j.id)));
  }

  async function bulkPause() {
    await Promise.all(bulk.pausable.map((j) => pauseJob(j.id)));
  }

  async function bulkCancel() {
    await Promise.all(bulk.stoppable.map((j) => cancelJob(j.id)));
  }

  async function bulkRetry() {
    await Promise.all(bulk.retryable.map((j) => retryJob(j.id)));
  }

  /**
   * Removing in bulk can throw away a lot of partial data at once, so unlike
   * the per-row delete this one asks first and says how much is at stake.
   */
  async function bulkRemove() {
    const withPartials = selectedJobs.filter((j) => j.status !== "completed" && j.outputPath).length;
    const warning = withPartials > 0 ? `\n\n${withPartials} of them still have partial files that will be deleted too.` : "";
    const confirmed = await confirm(`Remove ${selectedJobs.length} ${selectedJobs.length === 1 ? "download" : "downloads"} from the list?${warning}`, {
      title: "Remove selected downloads",
      kind: "warning",
    });
    if (!confirmed) return;

    // Sequential: each removal may cancel a download and delete files, and
    // firing all of them at once gains nothing.
    for (const job of selectedJobs) {
      await removeJob(job.id);
    }
    clearSelection();
  }

  const counts = useMemo(
    () => ({
      all: jobs.length,
      downloading: jobs.filter((j) => j.status === "downloading").length,
      queued: jobs.filter((j) => j.status === "queued").length,
      paused: jobs.filter((j) => j.status === "paused").length,
      interrupted: jobs.filter((j) => j.status === "interrupted").length,
      completed: jobs.filter((j) => j.status === "completed").length,
      cancelled: jobs.filter((j) => j.status === "cancelled").length,
      error: jobs.filter((j) => j.status === "error").length,
    }),
    [jobs],
  );

  const inspectedJob = jobs.find((j) => j.id === inspectedId) ?? null;
  const allVisibleSelected = filteredJobs.length > 0 && filteredJobs.every((j) => selectedIds.has(j.id));
  const filtersActive = statusFilter !== "all" || categoryFilter !== "all" || search.trim() !== "";
  const pageTitle =
    categoryFilter !== "all"
      ? (CATEGORY_FILTERS.find((c) => c.key === categoryFilter)?.label ?? "Downloads")
      : (STATUS_FILTERS.find((f) => f.key === statusFilter)?.label ?? "Downloads");
  const limitOptions: { value: string; label: string }[] = [...SPEED_LIMIT_OPTIONS];
  // A limit restored from an older session may not be one of the presets.
  if (!limitOptions.some((o) => o.value === globalLimit)) limitOptions.push({ value: globalLimit, label: globalLimit });
  const saveFolder = settings.defaultOutputDir ? baseName(settings.defaultOutputDir) : "";
  const widgetsVisible = settings.showWidgets && !inspectedJob;

  function resetFilters() {
    setStatusFilter("all");
    setCategoryFilter("all");
    setSearch("");
  }

  async function chooseSaveFolder() {
    const picked = await browsePath();
    if (picked) setSettings((prev) => ({ ...prev, defaultOutputDir: picked }));
  }

  const menuJob = menu ? (jobs.find((j) => j.id === menu.id) ?? null) : null;

  function openOverviewSettings() {
    setSettingsPage("appearance");
    setSettingsOpen(true);
  }

  function openSettings() {
    setSettingsPage("downloads");
    setSettingsOpen(true);
  }

  // App-wide shortcuts, listed for the user in ShortcutsDialog. Through a ref,
  // like the tray actions, so the listener is set up once.
  const shortcutRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    shortcutRef.current = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      // An open dialog owns the keyboard; Escape closes it first.
      if (settingsOpen || newDownloadOpen || shortcutsOpen || reportOpen || mediaToolsOpen) return;
      const key = e.key.toLowerCase();
      const action = { n: () => openNewDownload(), f: () => searchRef.current?.focus(), ",": openSettings, "/": () => setShortcutsOpen(true) }[key];
      if (!action) return;
      e.preventDefault();
      setSettingsMenu(null);
      action();
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => shortcutRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function changeView(next: ViewMode) {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // The choice still holds for this session.
    }
  }

  const reveal = (path: string) => void revealInFolder(path).catch(() => setNotice("File not found. It may have been moved or deleted."));

  function jobState(job: Job) {
    const canRetry = RETRYABLE_STATUSES.includes(job.status);
    // A stopped job that got somewhere has bytes worth keeping;
    // a finished one has no partial file left to continue from.
    const canContinue = canRetry && job.status !== "completed" && job.downloadedBytes > 0;
    return { pct: progressPercent(job), canRetry, canContinue };
  }

  function jobMenuItems(job: Job): MenuItem[] {
    const { pct, canRetry, canContinue } = jobState(job);
    const items: MenuItem[] = [{ label: "View details", icon: "info", run: () => setInspectedId(job.id) }];
    if (job.status === "completed" && job.outputPath) items.push({ label: "Show in folder", icon: "folder", run: () => reveal(job.outputPath) });
    items.push({ label: "Copy link", icon: "link", run: () => void copyToClipboard(job.url) });
    if (job.status === "downloading") items.push({ label: "Pause", icon: "pause", run: () => void pauseJob(job.id) });
    if (job.status === "paused") items.push({ label: "Resume", icon: "play", run: () => void resumeJob(job.id) });
    if (canRetry) items.push({ label: canContinue ? `Resume from ${pct}%` : "Download again", icon: canContinue ? "play" : "retry", run: () => void retryJob(job.id) });
    if (ACTIVE_STATUSES.includes(job.status)) items.push({ label: "Cancel", icon: "stop", run: () => void cancelJob(job.id) });
    items.push("separator", {
      label: "Remove",
      icon: "trash",
      danger: true,
      run: () => void removeJob(job.id),
    });
    return items;
  }

  function openMenuAt(job: Job, e: React.MouseEvent) {
    e.preventDefault();
    setMenu({ id: job.id, x: e.clientX, y: e.clientY });
  }

  function moreButton(job: Job) {
    return (
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu(menu?.id === job.id ? null : { id: job.id, x: r.right - 224, y: r.bottom + 6 });
        }}
        aria-haspopup="menu"
        aria-expanded={menu?.id === job.id}
        aria-label={`More actions for ${job.name}`}
        className="grid h-9 w-8 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-raised hover:text-ink"
      >
        <Icon name="more" className="text-lg" />
      </button>
    );
  }

  /** The one action a row puts in reach without opening the menu. */
  function primaryAction(job: Job) {
    const { pct, canRetry, canContinue } = jobState(job);
    const round = "grid h-9 w-9 shrink-0 place-items-center rounded-full transition-[filter]";
    if (job.status === "downloading")
      return (
        <button onClick={() => pauseJob(job.id)} className={`${round} bg-raised text-ink hover:brightness-125`} aria-label={`Pause ${job.name}`} title="Pause">
          <Icon name="pause" className="text-base" />
        </button>
      );
    if (job.status === "paused")
      return (
        <button onClick={() => resumeJob(job.id)} className={`${round} bg-accent text-accent-ink hover:brightness-110`} aria-label={`Resume ${job.name}`} title="Resume">
          <Icon name="play" className="text-base" />
        </button>
      );
    if (canRetry && job.status !== "completed")
      return (
        <button
          onClick={() => retryJob(job.id)}
          className={`${round} bg-raised text-ink hover:brightness-125`}
          aria-label={canContinue ? `Resume ${job.name} from ${pct}%` : `Download ${job.name} again`}
          title={canContinue ? `Resume from ${pct}%` : "Download again"}
        >
          <Icon name={canContinue ? "play" : "retry"} className="text-base" />
        </button>
      );
    if (job.status === "completed" && job.outputPath)
      return (
        <button onClick={() => reveal(job.outputPath)} className={`${round} bg-raised text-ink hover:brightness-125`} aria-label={`Show ${job.name} in folder`} title="Show in folder">
          <Icon name="folder" className="text-lg" />
        </button>
      );
    return null;
  }

  function selectBox(job: Job) {
    return (
      <input
        type="checkbox"
        checked={selectedIds.has(job.id)}
        // onClick, not onChange: only the mouse event carries
        // the shift key needed for range selection.
        onClick={(e) => toggleSelect(job.id, e.shiftKey)}
        onChange={() => {}}
        aria-label={`Select ${job.name}`}
        className={`absolute -bottom-0.5 -right-0.5 h-4 w-4 cursor-pointer rounded accent-[var(--accent)] focus-visible:opacity-100 ${selectedIds.size > 0 ? "" : "opacity-0 group-hover:opacity-100"}`}
      />
    );
  }

  function progressBar(job: Job, pct: number) {
    return (
      <div className="h-1 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Progress of ${job.name}`}>
        <div className={`relative h-full overflow-hidden rounded-full transition-[width] duration-300 ${job.status === "downloading" ? "bar-live" : ""}`} style={{ width: `${pct}%`, background: barColor(job.status) }} />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen gap-2 overflow-clip bg-bg p-2 text-[13px] text-ink">
      {/* Window controls float over the top-right corner of whichever pane is last. */}
      <div className="fixed right-4 top-4 z-30 flex items-center gap-0.5">
        <button onClick={() => appWindow.minimize()} className={WIN_BTN} aria-label="Minimize">
          <Icon name="minimize" className="text-base" />
        </button>
        <button onClick={() => appWindow.toggleMaximize()} className={WIN_BTN} aria-label="Maximize">
          <Icon name="maximize" className="text-[13px]" />
        </button>
        <button onClick={closeWindow} className={`${WIN_BTN} hover:!bg-danger hover:!text-white`} aria-label="Close (hide to tray, downloads keep running)" title="Hide to tray, downloads keep running. Quit fully from the tray menu.">
          <Icon name="close" className="text-base" />
        </button>
      </div>

      {/* Sidebar */}
      <aside className="pane flex w-64 shrink-0 flex-col p-2.5 select-none">
        <div data-tauri-drag-region className="flex shrink-0 gap-2 pb-3">
          <button
            onClick={() => setSettings((prev) => ({ ...prev, showWidgets: !prev.showWidgets }))}
            aria-pressed={settings.showWidgets}
            aria-label="Show or hide widgets"
            title={settings.showWidgets ? "Hide widgets" : "Show widgets"}
            className={`${TOP_PILL} ${settings.showWidgets ? "!text-ink" : ""}`}
          >
            <Icon name="widgets" className="text-lg" />
          </button>
          <button onClick={() => openNewDownload()} className="press grid h-10 flex-1 place-items-center rounded-full bg-accent text-accent-ink transition-[filter] hover:brightness-110" aria-label="New download" title="New download">
            <Icon name="plus" className="text-xl" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <nav aria-label="Status">
            <ul className="space-y-0.5">
              {STATUS_FILTERS.filter((f) => !f.hideWhenEmpty || counts[f.key as keyof typeof counts] > 0 || statusFilter === f.key).map((f) => {
                const active = statusFilter === f.key && categoryFilter === "all";
                const count = counts[f.key as keyof typeof counts];
                return (
                  <li key={f.key}>
                    <button
                      onClick={() => {
                        setStatusFilter(f.key);
                        setCategoryFilter("all");
                      }}
                      aria-current={active ? "page" : undefined}
                      className={`${NAV_ITEM} ${active ? NAV_ACTIVE : NAV_IDLE}`}
                    >
                      <Icon name={f.icon} className="text-[18px]" />
                      <span className="flex-1">{f.label}</span>
                      {count > 0 && (
                        <span className={`min-w-5 rounded-full px-1.5 text-center text-xs font-semibold ${f.key === "downloading" ? "bg-accent text-accent-ink" : "text-ink-3"}`}>{count}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <nav aria-label="File type">
            <p className="px-3 pb-1.5 text-xs font-medium text-ink-3">File types</p>
            <ul className="space-y-0.5">
              {CATEGORY_FILTERS.map((f) => {
                const active = categoryFilter === f.key;
                return (
                  <li key={f.key}>
                    <button onClick={() => setCategoryFilter(active ? "all" : f.key)} aria-pressed={active} className={`${NAV_ITEM} ${active ? NAV_ACTIVE : NAV_IDLE}`}>
                      <Icon name={categoryIcon(f.key)} className="text-[18px]" />
                      {f.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>

        <div className="shrink-0 space-y-0.5 pt-2">
          <button
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setSettingsMenu({ x: r.left, y: r.top - 6 });
            }}
            aria-haspopup="menu"
            aria-expanded={settingsMenu !== null}
            className={`${NAV_ITEM} ${settingsMenu ? NAV_ACTIVE : NAV_IDLE}`}
          >
            <Icon name="settings" className="text-[18px]" />
            Settings
          </button>
          <button onClick={() => setTheme(dark ? "light" : "dark")} aria-pressed={dark} className={`${NAV_ITEM} ${NAV_IDLE}`}>
            <Icon name={dark ? "sun" : "moon"} className="text-[18px]" />
            {dark ? "Light mode" : "Dark mode"}
          </button>
        </div>

        {/* App card, where BoardUI puts the account: status at a glance, plus the glass controls. */}
        <div className="mt-2 shrink-0 space-y-3 rounded-2xl bg-raised p-3">
          <div className="flex items-center gap-3">
            <img src="/nodo-mark.png" alt="" draggable={false} className="h-9 w-9 shrink-0 object-contain" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <div className="text-[15px] font-semibold text-ink">nodo</div>
                <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[9px] font-bold tracking-[0.08em] text-accent-text">BETA</span>
              </div>
            </div>
            <Switch checked={settings.glassEnabled} onChange={(v) => setSettings((prev) => ({ ...prev, glassEnabled: v }))} label="Glass mode" />
          </div>
          {settings.glassEnabled && (
            <label className="flex items-center gap-2.5 text-xs text-ink-2">
              <span className="shrink-0">Glass</span>
              <input
                type="range"
                min={40}
                max={100}
                value={Math.round(settings.glassOpacity * 100)}
                onChange={(e) => {
                  const glassOpacity = Number(e.currentTarget.value) / 100;
                  setSettings((prev) => ({ ...prev, glassOpacity }));
                }}
                aria-label="Glass opacity"
                className="min-w-0 flex-1 accent-[var(--accent)]"
              />
              <span className="w-8 shrink-0 text-right font-mono text-[11px] text-ink-3">{Math.round(settings.glassOpacity * 100)}%</span>
            </label>
          )}
        </div>
      </aside>

      {/* Downloads */}
      <main className="pane flex min-w-0 flex-1 flex-col">
        <header data-tauri-drag-region className={`flex shrink-0 items-center gap-3 px-4 pb-3 pt-4 ${widgetsVisible ? "pr-32 min-[1180px]:pr-4" : "pr-32"}`}>
          <div className="pointer-events-none inline-flex h-9 min-w-0 items-center gap-2 rounded-full bg-raised pl-1.5 pr-3.5">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent text-accent-ink">
              <Icon name={categoryFilter !== "all" ? categoryIcon(categoryFilter) : (STATUS_FILTERS.find((f) => f.key === statusFilter)?.icon ?? "download")} className="text-[13px]" />
            </span>
            <span className="truncate text-[13px] font-medium text-ink">{pageTitle}</span>
            <span className="text-[13px] text-ink-3">{filteredJobs.length}</span>
          </div>
          <SearchBox inputRef={searchRef} value={search} onChange={setSearch} jobs={jobs} onOpenJob={setInspectedId} />

        </header>

        <div className="flex shrink-0 items-center gap-1.5 px-4 pb-2">
          <div className="flex gap-1.5" role="tablist" aria-label="Quick filters">
          {([["all", "All"], ["downloading", "Downloading"], ["completed", "Completed"]] as const).map(([key, label]) => {
            const active = statusFilter === key && categoryFilter === "all";
            const n = counts[key as keyof typeof counts];
            return (
              <button
                key={key}
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setStatusFilter(key);
                  setCategoryFilter("all");
                }}
                className={`press inline-flex h-8 items-center gap-2 rounded-full px-3.5 text-xs font-medium transition-colors ${active ? "bg-ink text-white dark:text-neutral-950" : "bg-raised text-ink-2 hover:text-ink"}`}
              >
                {label}
                {key !== "all" && n > 0 && <span className={active ? "opacity-60" : "text-ink-3"}>{n}</span>}
              </button>
            );
          })}
          </div>
          <div className="ml-auto flex rounded-full bg-raised p-0.5" role="radiogroup" aria-label="View">
            {([["list", "list", "List view"], ["grid", "grid", "Card view"]] as const).map(([mode, icon, label]) => (
              <button
                key={mode}
                role="radio"
                aria-checked={view === mode}
                aria-label={label}
                title={label}
                onClick={() => changeView(mode)}
                className={`press grid h-7 w-9 place-items-center rounded-full transition-colors ${view === mode ? "bg-ink text-white dark:text-neutral-950" : "text-ink-2 hover:text-ink"}`}
              >
                <Icon name={icon} className="text-base" />
              </button>
            ))}
          </div>
        </div>
        {/* Bulk actions: a floating pill at the bottom, only while something is selected. */}
        {selectedIds.size > 0 && (
          <div className="pointer-events-none fixed inset-x-0 bottom-[72px] z-40 flex justify-center px-6">
            <div role="toolbar" aria-label="Selected downloads" className="modal sheet-in pointer-events-auto flex items-center gap-0.5 rounded-full p-1 pl-3.5">
              <span className="mr-1 whitespace-nowrap text-xs font-semibold tabular-nums text-ink">{selectedIds.size} selected</span>
              <button onClick={toggleSelectAll} className={PILL_BTN}>
                {allVisibleSelected ? "Deselect all" : "Select all"}
              </button>
              <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
              {bulk.resumable.length > 0 && (
                <button onClick={bulkResume} className={PILL_BTN} title="Resume">
                  <Icon name="play" className="text-sm text-ok-text" /> Resume
                </button>
              )}
              {bulk.pausable.length > 0 && (
                <button onClick={bulkPause} className={PILL_BTN} title="Pause">
                  <Icon name="pause" className="text-sm" /> Pause
                </button>
              )}
              {bulk.retryable.length > 0 && (
                <button onClick={bulkRetry} className={PILL_BTN} title="Retry">
                  <Icon name="retry" className="text-sm" /> Retry
                </button>
              )}
              {bulk.stoppable.length > 0 && (
                <button onClick={bulkCancel} className={PILL_BTN} title="Cancel">
                  <Icon name="stop" className="text-sm" /> Cancel
                </button>
              )}
              <button onClick={bulkRemove} className={`${PILL_BTN} text-danger-text`} title="Remove">
                <Icon name="trash" className="text-sm" /> Remove
              </button>
              <button onClick={clearSelection} aria-label="Clear selection" title="Clear selection" className="ml-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-field text-ink-2 transition-colors hover:text-ink">
                <Icon name="close" className="text-sm" />
              </button>
            </div>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto px-4 pb-3 pt-1">
              {!restored ? (
                <p className="py-16 text-center text-ink-2" role="status">
                  Loading downloads…
                </p>
              ) : filteredJobs.length === 0 ? (
                <div className="mx-auto flex max-w-sm flex-col items-center py-20 text-center">
                  <div className="grid h-14 w-14 place-items-center rounded-2xl bg-surface text-xl text-ink-2" aria-hidden="true">
                    <Icon name="emptyTray" />
                  </div>
                  {jobs.length === 0 ? (
                    <>
                      <h2 className="mt-4 text-base font-semibold">No downloads yet</h2>
                      <p className="mt-1 text-ink-2">Paste a URL, drag a link onto this window, or send one from the browser extension.</p>
                      <button onClick={() => openNewDownload()} className="mt-5 h-10 rounded-xl bg-accent px-4 text-[13px] font-semibold text-accent-ink hover:brightness-110">
                        New download
                      </button>
                    </>
                  ) : (
                    <>
                      <h2 className="mt-4 text-base font-semibold">No matches</h2>
                      <p className="mt-1 text-ink-2">{jobs.length} {jobs.length === 1 ? "download is" : "downloads are"} hidden by the active filter or search.</p>
                      {filtersActive && (
                        <button onClick={resetFilters} className="mt-5 h-10 rounded-xl bg-raised px-4 text-[13px] font-semibold hover:brightness-110">
                          Show all
                        </button>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <ul className={view === "grid" ? "grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2.5" : "space-y-2"}>
                  {filteredJobs.map((job) => {
                    const { pct } = jobState(job);
                    const meta = metaLine(job);
                    const ring = inspectedId === job.id ? "ring-1 ring-accent" : "";
                    const shownPct = job.sizeBytes > 0 || job.status === "completed" ? `${pct}%` : "";
                    if (view === "grid")
                      return (
                        <li key={job.id} onContextMenu={(e) => openMenuAt(job, e)} className={`card group relative flex flex-col rounded-[20px] p-3 select-none ${ring}`}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="relative">
                              <FileThumb name={job.name} path={job.outputPath} done={job.status === "completed"} category={job.category} size={52} />
                              {selectBox(job)}
                            </div>
                            <div className="flex items-center">
                              {primaryAction(job)}
                              {moreButton(job)}
                            </div>
                          </div>
                          <button onClick={() => setInspectedId(job.id)} className="mt-3 min-w-0 text-left" aria-label={`Details for ${job.name}`}>
                            <div className="line-clamp-2 min-h-[2.6em] break-words text-[13px] font-semibold leading-snug">{job.name}</div>
                            <div className="mt-0.5 truncate text-xs text-ink-3">{hostOf(job.url)}</div>
                          </button>
                          <div className="mt-3">
                            {progressBar(job, pct)}
                            <div className="mt-1.5 flex justify-between gap-2 text-[11px]">
                              <span className={`truncate ${TONE_CLASS[meta.tone]}`}>{meta.text}</span>
                              <span className="shrink-0 tabular-nums text-ink-3">{shownPct}</span>
                            </div>
                          </div>
                        </li>
                      );
                    return (
                      <li key={job.id} onContextMenu={(e) => openMenuAt(job, e)} className={`card group relative flex items-center gap-3 rounded-2xl py-2.5 pl-3 pr-2 select-none ${ring}`}>
                        <div className="relative shrink-0">
                          <FileThumb name={job.name} path={job.outputPath} done={job.status === "completed"} category={job.category} size={40} />
                          {selectBox(job)}
                        </div>
                        <button onClick={() => setInspectedId(job.id)} className="min-w-0 flex-1 text-left" aria-label={`Details for ${job.name}`}>
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="truncate text-[13px] font-semibold">{job.name}</span>
                            <span className="shrink-0 text-xs tabular-nums text-ink-2">{shownPct}</span>
                          </div>
                          <div className="mt-1.5">{progressBar(job, pct)}</div>
                          <div className="mt-1 truncate text-xs text-ink-3">
                            {hostOf(job.url)} · <span className={TONE_CLASS[meta.tone]}>{meta.text}</span>
                          </div>
                        </button>
                        {primaryAction(job)}
                        {moreButton(job)}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <footer className="card mx-3 mb-3 flex shrink-0 items-center gap-1 rounded-full py-1 pl-3 pr-1.5 text-xs">
              <Icon name="speed" className="text-base text-ink-3" />
              <span className="ml-1 text-ink-3">Speed limit</span>
              <Select
                variant="ghost"
                placement="top"
                aria-label="Download speed limit"
                className="ml-1"
                value={globalLimit}
                onChange={(v) => void applyGlobalLimit(v)}
                options={limitOptions.map((o) => ({ value: o.value, label: o.value === "" ? "No limit" : o.label }))}
              />
              <span className="mx-2.5 h-4 w-px bg-line" aria-hidden="true" />
              <button
                onClick={() => void chooseSaveFolder()}
                className="press flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1 text-left transition-colors hover:bg-raised"
                title={settings.defaultOutputDir || "Choose a save folder"}
              >
                <Icon name="folder" className="shrink-0 text-base text-ink-3" />
                <span className="text-ink-3">Save to</span>
                <span className="max-w-48 truncate text-[13px] font-medium text-ink">{saveFolder || "Choose folder…"}</span>
              </button>
            </footer>
          </div>

        </div>
      </main>

      {widgetsVisible && (
        <aside className="pane hidden w-[320px] shrink-0 flex-col min-[1180px]:flex" aria-label="Overview">
          <div data-tauri-drag-region className="flex h-[60px] shrink-0 items-center gap-2 pl-5 pr-32">
            <h2 className="pointer-events-none text-[15px] font-semibold text-ink">Overview</h2>
            <button
              onClick={openOverviewSettings}
              aria-label="Choose Overview cards"
              title="Choose what Overview shows"
              className="press grid h-7 w-7 place-items-center rounded-full text-ink-3 transition-colors hover:bg-raised hover:text-ink"
            >
              <Icon name="sliders" className="text-sm" />
            </button>
          </div>
          <Widgets
            speedHistory={speedHistory}
            jobs={jobs}
            outputDir={settings.defaultOutputDir}
            concurrency={settings.concurrency}
            onConcurrency={(value) => setSettings((prev) => ({ ...prev, concurrency: Math.max(1, Math.min(10, value)) }))}
            onFilter={(status) => {
              setStatusFilter(status);
              setCategoryFilter("all");
            }}
            onReveal={(path) => void revealInFolder(path).catch(() => setNotice("Not found. It may have been moved or deleted."))}
            onChooseFolder={() => void chooseSaveFolder()}
            layout={normalizeOverview(settings.overview)}
            onCustomize={openOverviewSettings}
          />
        </aside>
      )}

      {menu && menuJob && <ContextMenu x={menu.x} y={menu.y} items={jobMenuItems(menuJob)} onClose={() => setMenu(null)} />}

      {settingsMenu && (
        <ContextMenu
          x={settingsMenu.x}
          y={settingsMenu.y}
          above
          label="Settings and help"
          onClose={() => setSettingsMenu(null)}
          items={[
            { label: "Keyboard shortcuts", icon: "keyboard", shortcut: "Ctrl+/", run: () => setShortcutsOpen(true) },
            { label: "Report an issue", icon: "bug", run: () => setReportOpen(true) },
            "separator",
            { label: "Settings", icon: "settings", shortcut: "Ctrl+,", run: openSettings },
          ]}
        />
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {reportOpen && <ReportIssueDialog jobs={jobs} settings={settings} onClose={() => setReportOpen(false)} />}

      {inspectedJob && <InspectorDrawer job={inspectedJob} onClose={() => setInspectedId(null)} />}

      {/* Drop overlay. pointer-events-none keeps it from eating the drop. */}
      {dragActive && (
        <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-surface px-10 py-8 text-center">
            <Icon name="link" className="text-3xl text-accent-text" />
            <div className="mt-3 font-semibold">Drop links to add downloads</div>
            <div className="mt-1 text-xs text-ink-2">Multiple links at once work too</div>
          </div>
        </div>
      )}

      {(clipboardUrl || notice) && (
        <div className="fixed bottom-6 right-6 z-[70] flex w-80 flex-col gap-2" role="status">
          {clipboardUrl && (
            <div className="modal sheet-in rounded-2xl p-3">
              <div className="flex items-center gap-3">
                <FileThumb name={nameFromUrl(clipboardUrl)} path="" done={false} category={detectCategory(nameFromUrl(clipboardUrl))} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-ink-3">Copied link</div>
                  <div className="truncate text-[13px] font-semibold text-ink" title={clipboardUrl}>
                    {nameFromUrl(clipboardUrl)}
                  </div>
                  <div className="truncate text-[11px] text-ink-3">{hostOf(clipboardUrl)}</div>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button onClick={() => setClipboardUrl("")} className={`${SECONDARY_BTN} flex-1`}>
                  Dismiss
                </button>
                <button onClick={() => openNewDownload(clipboardUrl)} className={`${PRIMARY_BTN} flex-1`}>
                  <Icon name="download" className="text-base" /> Download
                </button>
              </div>
            </div>
          )}
          {notice && (
            <div className="flex items-start gap-2 rounded-2xl border border-line bg-raised px-4 py-3 shadow-xl">
              <Icon name="info" className="mt-0.5 text-accent-text" />
              <span className="flex-1 text-xs">{notice}</span>
              <button onClick={() => setNotice("")} className="text-ink-3 hover:text-ink" aria-label="Dismiss message">
                <Icon name="close" className="text-xs" />
              </button>
            </div>
          )}
        </div>
      )}

      {newDownloadOpen && (
        <NewDownloadModal
          defaultSegments={settings.defaultSegments}
          defaultLimit={settings.defaultLimit}
          defaultOutputDir={settings.defaultOutputDir}
          initialUrl={pendingUrl}
          duplicateOf={(url) => findByUrl(jobs, url)}
          onClose={closeNewDownload}
          onSubmit={(input) => {
            handleCreateJob(input);
            closeNewDownload();
          }}
          onBrowse={browsePath}
        />
      )}

      {mediaToolsOpen && <MediaToolsDialog onClose={() => setMediaToolsOpen(false)} onInstalled={onMediaToolsInstalled} />}

      {settingsOpen && <SettingsModal initialPage={settingsPage} onMediaTools={() => setMediaToolsOpen(true)} settings={settings} onClose={() => setSettingsOpen(false)} onSave={setSettings} onBrowse={browsePath} onGlass={(patch) => setSettings((prev) => ({ ...prev, ...patch }))} theme={theme} onTheme={setTheme} />}
    </div>
  );
}

export default App;
