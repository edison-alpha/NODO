import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, Job, ThemeMode } from "../types";

/** Bumped whenever the saved shape changes in a way old files can't satisfy. */
const VERSION = 1;

export interface PersistedState {
  version: number;
  /** What the theme resolved to; files saved before `theme` existed only have this. */
  dark: boolean;
  theme?: ThemeMode;
  globalLimit: string;
  settings: AppSettings;
  jobs: Job[];
}

/** Fields that only mean something while a download is actually running. */
function stripRuntimeFields(job: Job): Job {
  return { ...job, speedBytes: 0, lastTick: null };
}

/**
 * A job that was mid-flight when the app closed has no engine handle anymore,
 * so it comes back flagged rather than pretending it can just carry on.
 */
function restoreStatus(job: Job): Job {
  if (job.status === "downloading" || job.status === "paused") {
    return { ...job, status: "interrupted" };
  }
  return job;
}

function isPlausibleJob(value: unknown): value is Job {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<Job>;
  return typeof job.id === "string" && typeof job.url === "string" && typeof job.name === "string";
}

export async function loadState(): Promise<Partial<PersistedState> | null> {
  try {
    const raw = await invoke<PersistedState | null>("load_app_state");
    if (!raw || raw.version !== VERSION) return null;

    return {
      ...raw,
      jobs: Array.isArray(raw.jobs) ? raw.jobs.filter(isPlausibleJob).map(stripRuntimeFields).map(restoreStatus) : [],
    };
  } catch (err) {
    console.error("could not load saved state", err);
    return null;
  }
}

export async function saveState(state: Omit<PersistedState, "version">): Promise<void> {
  try {
    await invoke("save_app_state", {
      state: {
        version: VERSION,
        ...state,
        jobs: state.jobs.map(stripRuntimeFields),
      },
    });
  } catch (err) {
    console.error("could not save state", err);
  }
}
