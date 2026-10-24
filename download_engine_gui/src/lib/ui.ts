import type { FileCategory, Job, JobStatus } from "../types";
import { formatBytes } from "./format";
import type { IconName } from "./icon-data";

/** Shared by the main window and the island so a file looks the same in both. */
export function categoryIcon(category: FileCategory): IconName {
  switch (category) {
    case "compressed":
      return "archives";
    case "documents":
      return "documents";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "programs":
      return "apps";
    default:
      return "file";
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/** Fill colour of a progress bar: state, not decoration. */
export function barColor(status: JobStatus): string {
  switch (status) {
    case "error":
      return "var(--danger)";
    case "completed":
      return "var(--ok)";
    case "paused":
    case "interrupted":
      return "var(--warn)";
    case "cancelled":
    case "queued":
      return "var(--ink-3)";
    default:
      return "var(--accent)";
  }
}

export function activeJobs(jobs: Job[]): Job[] {
  return jobs.filter((j) => j.status === "downloading" || j.status === "paused");
}
