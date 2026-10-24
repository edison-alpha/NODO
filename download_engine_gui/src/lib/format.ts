import type { FileCategory, Job } from "../types";

export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
}

export function detectCategory(name: string): FileCategory {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["zip", "rar", "7z", "tar", "gz", "dat"].includes(ext)) return "compressed";
  if (["pdf", "doc", "docx", "txt"].includes(ext)) return "documents";
  if (["mp4", "mkv", "avi", "webm", "mov"].includes(ext)) return "video";
  if (["mp3", "wav", "flac", "m4a", "ogg", "aac"].includes(ext)) return "audio";
  if (["exe", "msi", "iso", "dmg", "deb"].includes(ext)) return "programs";
  return "other";
}

export function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last || "download.bin";
  } catch {
    return url.split("/").pop() || "download.bin";
  }
}

/** Joins an output folder and a file name, however the folder was typed. */
export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}\\${name}`;
}

/**
 * Inserts " (n)" before the extension until the path isn't taken.
 *
 * Two jobs aimed at one file would write over each other's bytes, so a
 * collision has to be resolved before the job is created — the same thing a
 * browser does when you download one file twice.
 */
export function uniqueOutputPath(path: string, taken: ReadonlySet<string>): string {
  if (!path || !taken.has(path)) return path;
  const slash = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const dot = path.lastIndexOf(".");
  // The dot has to sit inside the file name and not start it, otherwise
  // ".gitignore" would be treated as an extension with an empty name.
  const hasExt = dot > slash + 1;
  const stem = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : "";
  // Bounded: at worst every taken path blocks exactly one candidate.
  for (let n = 1; n <= taken.size; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem} (${taken.size + 1})${ext}`;
}

/** File name part of a path, for keeping the displayed name in sync with it. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function calculateEta(job: Job): string {
  if (job.status !== "downloading" || job.speedBytes <= 0 || job.sizeBytes <= 0) return "-";
  const remaining = job.sizeBytes - job.downloadedBytes;
  const seconds = Math.ceil(remaining / job.speedBytes);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  return `${mins}m ${seconds % 60}s`;
}

export function progressPercent(job: Job): number {
  if (job.status === "completed") return 100;
  if (job.sizeBytes <= 0) return 0;
  return Math.min(100, Math.round((job.downloadedBytes / job.sizeBytes) * 100));
}
