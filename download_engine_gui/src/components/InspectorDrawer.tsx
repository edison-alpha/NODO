import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Job, SegmentProgress } from "../types";
import Icon from "./Icon";
import { ICON_BTN } from "./controls";
import { baseName, formatBytes, progressPercent } from "../lib/format";
import { extOf } from "../lib/fileIcon";
import { hostOf } from "../lib/ui";
import FileThumb from "./FileThumb";
import { copyToClipboard, revealInFolder } from "../lib/jobActions";

interface Props {
  job: Job;
  onClose: () => void;
}

const LIVE_STATUSES = ["downloading", "paused"];

const STATUS_LABEL: Record<Job["status"], string> = {
  queued: "Queued",
  downloading: "Downloading",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
  error: "Failed",
  interrupted: "Interrupted",
};

/** The folder a path sits in, without the file name. */
function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : path;
}

export default function InspectorDrawer({ job, onClose }: Props) {
  const pct = progressPercent(job);
  const [segments, setSegments] = useState<SegmentProgress[]>([]);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  // The engine pre-allocates the file when a job starts, so anything that has
  // run has something on disk to reveal. A queued job has nothing yet.
  const fileExists = Boolean(job.outputPath) && job.status !== "queued";

  async function runAction(message: string, action: () => Promise<void>) {
    try {
      await action();
      setFeedback({ ok: true, message });
    } catch (err) {
      setFeedback({ ok: false, message: String(err) });
    }
  }

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 2200);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  // The engine tracks segments in shared memory rather than emitting an event
  // per chunk, so poll it at a rate a human can actually read.
  useEffect(() => {
    if (!LIVE_STATUSES.includes(job.status)) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const next = await invoke<SegmentProgress[]>("segment_progress", { jobId: job.id });
        if (!cancelled && next.length > 0) setSegments(next);
      } catch {
        /* job finished between renders; keep the last snapshot */
      }
    };

    poll();
    const timer = window.setInterval(poll, 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [job.id, job.status]);

  // A fresh job shouldn't show the previous one's segments, nor a confirmation
  // that was meant for it.
  useEffect(() => {
    setSegments([]);
    setFeedback(null);
  }, [job.id]);

  const actionBtn =
    "flex flex-col items-center gap-1.5 press rounded-xl bg-surface py-3 text-[11px] font-medium text-ink-2 transition-colors hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ink-2";

  return (
    <div className="pane sheet-in flex w-80 shrink-0 flex-col overflow-hidden">
      <div className="flex-1 space-y-4 overflow-y-auto p-5 pt-14">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <Icon name="chip" className="text-accent-text" /> Details
          </h3>
          <button onClick={onClose} className={ICON_BTN} aria-label="Close details">
            <Icon name="close" className="text-sm" />
          </button>
        </div>

        <div className="flex flex-col items-center pt-1 text-center">
          <FileThumb name={job.name} path={job.outputPath} done={job.status === "completed"} category={job.category} size={88} />
          <div className="mt-3 line-clamp-2 break-words text-sm font-semibold text-ink">{job.name}</div>
          <div className="mt-0.5 text-xs text-ink-3">
            {(extOf(job.name) || "file").toUpperCase()} · {job.sizeBytes > 0 ? formatBytes(job.sizeBytes) : "Unknown size"}
          </div>
        </div>

        <dl className="divide-y divide-line rounded-2xl bg-surface px-3.5 text-xs">
          {[
            ["Status", job.sizeBytes > 0 && job.status !== "completed" ? `${STATUS_LABEL[job.status]} · ${pct}%` : STATUS_LABEL[job.status]],
            ["Downloaded", job.sizeBytes > 0 ? `${formatBytes(job.downloadedBytes)} of ${formatBytes(job.sizeBytes)}` : formatBytes(job.downloadedBytes)],
            ["Source", hostOf(job.url)],
            ["Added", new Date(job.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })],
            ["Folder", job.outputPath ? baseName(folderOf(job.outputPath)) : "App folder"],
            job.kind === "media" ? ["Quality", job.media?.label ?? "Best"] : ["Connections", String(job.segments)],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-3 py-2.5">
              <dt className="shrink-0 text-ink-3">{k}</dt>
              <dd className="min-w-0 truncate text-right text-ink" title={v}>
                {v}
              </dd>
            </div>
          ))}
        </dl>

        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => runAction("Folder opened", () => revealInFolder(job.outputPath))}
              disabled={!fileExists}
              title={fileExists ? "Show file in File Explorer" : "No file on disk to show yet"}
              className={actionBtn}
            >
              <Icon name="folder" className="text-lg" />
              <span>Open folder</span>
            </button>
            <button onClick={() => runAction("Link copied", () => copyToClipboard(job.url))} title="Copy download URL to clipboard" className={actionBtn}>
              <Icon name="link" className="text-lg" />
              <span>Copy link</span>
            </button>
            <button
              onClick={() => runAction("Path copied", () => copyToClipboard(job.outputPath))}
              disabled={!job.outputPath}
              title={job.outputPath ? "Copy output file path to clipboard" : "This download has no explicit output path"}
              className={actionBtn}
            >
              <Icon name="clipboard" className="text-lg" />
              <span>Copy path</span>
            </button>
          </div>

          {feedback && (
            <div className={`flex items-start gap-1.5 break-all rounded-xl px-3 py-2 text-[11px] ${feedback.ok ? "bg-[color-mix(in_srgb,var(--ok)_12%,transparent)] text-ok-text" : "bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger-text"}`}>
              <Icon name={feedback.ok ? "checkCircle" : "alertCircle"} className="mt-0.5" />
              <span>{feedback.message}</span>
            </div>
          )}
        </div>

        {/* A failed job never got a usable answer about range support, so
            `supportsRange === false` here means "unknown", not "unsupported".
            Showing the amber "Range Not Supported" panel beside the real error
            invents a server capability we never observed and sends the reader
            after the wrong cause. The error below says what actually happened. */}
        {job.error || job.kind === "media" ? null : job.supportsRange === null ? (
          <div className="flex items-start gap-2 rounded-xl bg-surface p-3">
            <Icon name="spinner" className="mt-0.5 animate-spin text-xs text-ink-3" />
            <div className="text-xs text-ink-2">Probing server...</div>
          </div>
        ) : job.supportsRange ? (
          <div className="flex items-start gap-2 rounded-xl bg-[color-mix(in_srgb,var(--ok)_10%,transparent)] p-3">
            <Icon name="checkCircle" className="mt-0.5 text-xs text-ok-text" />
            <div className="text-xs">
              <div className="font-semibold text-ok-text">Accept-Ranges supported</div>
              <div className="mt-0.5 text-[11px] text-ink-2">The server supports HTTP byte ranges, so the download is split into {job.segments} parallel segments.</div>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-xl bg-[color-mix(in_srgb,var(--warn)_12%,transparent)] p-3">
            <Icon name="warning" className="mt-0.5 text-xs text-warn" />
            <div className="text-xs">
              <div className="font-semibold text-warn">Range not supported</div>
              <div className="mt-0.5 text-[11px] text-ink-2">The server does not support byte ranges; falling back to a single streaming connection.</div>
            </div>
          </div>
        )}

        {job.kind !== "media" && (
        <div>
          <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-ink-3">
            <span>Connections</span>
            <span className="font-mono normal-case tracking-normal">{segments.length || job.segments} threads</span>
          </div>

          {segments.length > 0 ? (
            <div className="space-y-1.5">
              {segments.map((segment) => {
                const segmentPct = segment.total > 0 ? Math.min(100, Math.round((segment.downloaded / segment.total) * 100)) : 0;
                return (
                  <div key={segment.index} className="space-y-1.5 rounded-xl bg-surface p-2.5">
                    <div className="flex items-center justify-between font-mono text-[10px]">
                      <span className="font-semibold text-ink-2">#{segment.index + 1}</span>
                      <span className="text-accent-text">{segmentPct}%</span>
                    </div>
                    <div className="h-1 w-full overflow-hidden rounded-full bg-field">
                      <div className="h-full rounded-full transition-all duration-300" style={{ width: `${segmentPct}%`, background: job.status === "paused" ? "var(--warn)" : "var(--accent)" }} />
                    </div>
                    <div className="font-mono text-[10px] text-ink-3">
                      {formatBytes(segment.downloaded)} / {formatBytes(segment.total)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl bg-surface p-3 text-[11px] text-ink-3">
              {LIVE_STATUSES.includes(job.status) ? "Waiting for segments to start..." : "Per-segment breakdown is only available while downloading."}
            </div>
          )}
        </div>
        )}

        <div className="space-y-1.5 rounded-xl bg-surface p-3 text-xs">
          <div className="font-medium text-ink-3">Output path</div>
          <div className="break-all font-mono text-[11px] text-ink-2">{job.outputPath || "(current working directory)"}</div>
        </div>


        {job.error && <div className="break-all rounded-xl bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] p-3 text-xs text-danger-text">{job.error}</div>}
      </div>
    </div>
  );
}