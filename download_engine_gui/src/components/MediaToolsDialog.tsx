import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MediaToolsStatus } from "../types";
import { formatBytes } from "../lib/format";
import Icon from "./Icon";
import { PRIMARY_BTN, SECONDARY_BTN } from "./controls";
import { Sheet, SheetHeader } from "./Sheet";

interface Props {
  onClose: () => void;
  /** Called once both tools are in place, so waiting video jobs can start. */
  onInstalled: () => void;
}

const TOOLS = [
  { key: "ytdlp" as const, name: "yt-dlp", what: "Reads video pages and fetches the streams", size: "≈ 18 MB", source: "github.com/yt-dlp/yt-dlp" },
  { key: "ffmpeg" as const, name: "FFmpeg", what: "Joins video and audio, converts to MP3", size: "≈ 90 MB", source: "github.com/yt-dlp/FFmpeg-Builds" },
];

/**
 * Asks before fetching the video tools, says exactly what will be downloaded
 * and from where, and shows it happening. Nothing is fetched until the button.
 */
export default function MediaToolsDialog({ onClose, onInstalled }: Props) {
  const [status, setStatus] = useState<MediaToolsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<Record<string, { downloaded: number; total: number }>>({});

  useEffect(() => {
    invoke<MediaToolsStatus>("media_tools_status").then(setStatus, () => setStatus({ ytdlp: false, ffmpeg: false }));
    const unlisten = listen<{ tool: string; downloaded: number; total: number }>("media-tools-progress", (e) => {
      const { tool, downloaded, total } = e.payload;
      setProgress((prev) => ({ ...prev, [tool]: { downloaded, total } }));
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const ready = status?.ytdlp && status?.ffmpeg;

  async function install() {
    setBusy(true);
    setError("");
    try {
      const next = await invoke<MediaToolsStatus>("install_media_tools");
      setStatus(next);
      if (next.ytdlp && next.ffmpeg) onInstalled();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={busy ? () => {} : onClose} label="Video downloads" className="w-[460px] flex-col">
      <SheetHeader title="Video downloads" subtitle="YouTube and other video sites need two free tools." onClose={busy ? () => {} : onClose} />
      <div className="space-y-3 px-7 pb-5">
        <ul className="divide-y divide-line rounded-2xl bg-sheet-2 px-4">
          {TOOLS.map((t) => {
            const have = status?.[t.key];
            const p = progress[t.key === "ytdlp" ? "yt-dlp" : "ffmpeg"];
            const pct = p && p.total > 0 ? Math.round((p.downloaded / p.total) * 100) : 0;
            return (
              <li key={t.key} className="py-3">
                <div className="flex items-center gap-3">
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${have ? "bg-[color-mix(in_srgb,var(--ok)_16%,transparent)] text-ok-text" : "bg-raised text-ink-2"}`}>
                    <Icon name={have ? "check" : "download"} className="text-base" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-ink">
                      {t.name} <span className="font-normal text-ink-3">· {t.size}</span>
                    </div>
                    <div className="truncate text-xs text-ink-3">{t.what}</div>
                  </div>
                  <span className="shrink-0 text-xs text-ink-3">{have ? "Installed" : busy && p ? `${pct}%` : ""}</span>
                </div>
                {busy && !have && p && (
                  <div className="mt-2 pl-11">
                    <div className="h-1 overflow-hidden rounded-full bg-field">
                      <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mt-1 text-[11px] tabular-nums text-ink-3">
                      {formatBytes(p.downloaded)} of {p.total > 0 ? formatBytes(p.total) : "…"}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="px-1 text-xs leading-relaxed text-ink-3">
          Downloaded once from each project's official GitHub release ({TOOLS.map((t) => t.source).join(", ")}), checked against the SHA-256 list published with it, and kept
          in the app's own folder. Only download videos you have the right to save.
        </p>
        {error && (
          <p className="flex items-start gap-2 rounded-xl bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-3 py-2.5 text-xs text-danger-text">
            <Icon name="warning" className="mt-0.5 text-sm" />
            {error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-line px-7 py-4">
        <button type="button" onClick={onClose} disabled={busy} className={SECONDARY_BTN}>
          {ready ? "Close" : "Not now"}
        </button>
        {!ready && (
          <button type="button" onClick={() => void install()} disabled={busy || !status} className={PRIMARY_BTN}>
            <Icon name={busy ? "spinner" : "download"} className={`text-base ${busy ? "animate-spin" : ""}`} />
            {busy ? "Installing…" : "Install"}
          </button>
        )}
      </div>
    </Sheet>
  );
}
