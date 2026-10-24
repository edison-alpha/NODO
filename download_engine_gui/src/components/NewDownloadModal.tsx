import { useState } from "react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import type { NewJobInput } from "../types";
import { baseName, detectCategory, nameFromUrl } from "../lib/format";
import { hostOf } from "../lib/ui";
import Icon from "./Icon";
import FileThumb from "./FileThumb";
import { FIELD, GHOST_BTN, HINT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from "./controls";
import { Sheet, SheetHeader } from "./Sheet";
import Select from "./Select";

interface Props {
  defaultSegments: number;
  defaultLimit: string;
  /** Seeds the folder field; emptying it falls back to this same value anyway. */
  defaultOutputDir: string;
  /** Pre-filled when the modal was opened by dropping a link onto the window. */
  initialUrl?: string;
  /** Existing job for this URL, so the form can warn before it's submitted. */
  duplicateOf: (url: string) => { name: string; status: string } | undefined;
  onClose: () => void;
  onSubmit: (input: NewJobInput) => void;
  onBrowse: () => Promise<string | null>;
}

const LIMIT_OPTIONS = [
  { value: "", label: "Unlimited" },
  { value: "500KB", label: "500 KB/s" },
  { value: "2MB", label: "2 MB/s" },
  { value: "10MB", label: "10 MB/s" },
];

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export default function NewDownloadModal({ defaultSegments, defaultLimit, defaultOutputDir, initialUrl = "", duplicateOf, onClose, onSubmit, onBrowse }: Props) {
  const [url, setUrl] = useState(initialUrl);
  // Pre-filled rather than left to the placeholder, so the folder the file is
  // actually going to is visible without opening Browse first.
  const [outputPath, setOutputPath] = useState(defaultOutputDir);
  // Left blank on purpose: blank is what lets the server's own
  // `Content-Disposition` name win once the probe comes back, which is the
  // only way a link like "/download?id=84213" ends up named sensibly.
  const [fileName, setFileName] = useState("");
  const [segments, setSegments] = useState(defaultSegments);
  const [limit, setLimit] = useState(defaultLimit);
  const [startInSec, setStartInSec] = useState(0);
  const [showOptions, setShowOptions] = useState(false);

  const trimmed = url.trim();
  const valid = isHttpUrl(trimmed);
  // Only a warning, never a block: re-downloading a link whose file changed on
  // the server is a legitimate thing to want.
  const duplicate = trimmed ? duplicateOf(trimmed) : undefined;
  const previewName = fileName.trim() || (valid ? nameFromUrl(trimmed) : "");

  async function handleBrowse() {
    const picked = await onBrowse();
    if (picked) setOutputPath(picked);
  }

  async function pasteLink() {
    try {
      const text = (await readText())?.trim() ?? "";
      if (text) setUrl(text);
    } catch {
      // Empty or non-text clipboard: nothing to paste.
    }
  }

  function submit(forceStart: boolean) {
    if (!valid) return;
    onSubmit({ url: trimmed, outputPath: outputPath.trim(), fileName: fileName.trim(), segments, limit, startInSec, forceStart });
  }

  return (
    <Sheet onClose={onClose} label="Add download" className="w-[500px] flex-col">
      <SheetHeader title="Add download" onClose={onClose} />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(true);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-7 pb-5">
          <div className="relative">
            <Icon name="link" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-lg text-ink-3" />
            <input
              type="url"
              required
              autoFocus
              aria-label="Download link"
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
              placeholder="Paste a link to download"
              className={`${FIELD} h-12 rounded-xl pl-11 pr-24 text-sm`}
            />
            {!trimmed && (
              <button type="button" onClick={() => void pasteLink()} className={`${SECONDARY_BTN} absolute right-1.5 top-1/2 h-9 -translate-y-1/2`}>
                <Icon name="clipboard" className="text-base" /> Paste
              </button>
            )}
          </div>

          {valid && (
            <div className="flex items-center gap-3 rounded-2xl bg-sheet-2 p-3">
              <FileThumb name={previewName} path="" done={false} category={detectCategory(previewName)} size={44} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-ink">{previewName || "Unnamed file"}</div>
                <div className="truncate text-xs text-ink-3">{hostOf(trimmed)}</div>
              </div>
            </div>
          )}
          {trimmed && !valid && <p className="px-1 text-xs text-danger-text">That doesn't look like an http(s) link.</p>}
          {duplicate && (
            <div className="flex items-start gap-2 rounded-xl bg-[color-mix(in_srgb,var(--warn)_12%,transparent)] px-3 py-2.5 text-xs leading-relaxed text-ink-2">
              <Icon name="warning" className="mt-0.5 text-base text-warn" />
              <span>
                Already in your list as <span className="font-semibold text-ink">{duplicate.name}</span>. Downloading again saves a separate copy.
              </span>
            </div>
          )}

          <div className="flex items-center gap-3 rounded-2xl bg-sheet-2 py-2.5 pl-3.5 pr-2">
            <Icon name="folder" className="text-lg text-ink-2" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] text-ink-3">Save to</div>
              <div className="truncate text-[13px] font-medium text-ink" title={outputPath}>
                {outputPath ? baseName(outputPath) : "App folder"}
              </div>
            </div>
            <button type="button" onClick={() => void handleBrowse()} className={GHOST_BTN}>
              Change
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowOptions((v) => !v)}
            aria-expanded={showOptions}
            className="flex w-full items-center gap-1.5 px-1 pt-1 text-xs font-medium text-ink-2 hover:text-ink"
          >
            <Icon name="chevronUp" className={`text-sm transition-transform ${showOptions ? "" : "rotate-180"}`} />
            More options
          </button>

          {showOptions && (
            <div className="space-y-4 rounded-2xl bg-sheet-2 p-4">
              <div>
                <label htmlFor="nd-name" className={LABEL}>
                  File name
                </label>
                <input id="nd-name" type="text" value={fileName} onChange={(e) => setFileName(e.currentTarget.value)} placeholder="Use the name from the server" className={`${FIELD} bg-sheet`} />
                <span className={HINT}>Leave empty to use the name the server sends.</span>
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label htmlFor="nd-seg" className="text-[13px] font-medium text-ink">
                    Connections
                  </label>
                  <span className="font-mono text-xs font-semibold text-accent-text">{segments}</span>
                </div>
                <input id="nd-seg" type="range" min={1} max={32} value={segments} onChange={(e) => setSegments(Number(e.currentTarget.value))} className="w-full cursor-pointer accent-[var(--accent)]" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="nd-limit" className={LABEL}>
                    Speed limit
                  </label>
                  <Select id="nd-limit" value={limit} onChange={setLimit} options={LIMIT_OPTIONS} />
                </div>
                <div>
                  <label htmlFor="nd-delay" className={LABEL}>
                    Start after (sec)
                  </label>
                  <input id="nd-delay" type="number" min={0} value={startInSec} onChange={(e) => setStartInSec(Number(e.currentTarget.value) || 0)} className={`${FIELD} bg-sheet font-mono`} />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-7 py-4">
          <button type="button" onClick={() => submit(false)} disabled={!valid} className={SECONDARY_BTN}>
            Add to queue
          </button>
          <button type="submit" disabled={!valid} className={PRIMARY_BTN}>
            <Icon name="download" className="text-base" /> Download
          </button>
        </div>
      </form>
    </Sheet>
  );
}
