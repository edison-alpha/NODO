import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { AppSettings, Job, JobStatus } from "../types";
import { copyToClipboard } from "../lib/jobActions";
import Icon from "./Icon";
import { FIELD, HINT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from "./controls";
import { Sheet, SheetHeader } from "./Sheet";

interface Props {
  jobs: Job[];
  settings: AppSettings;
  onClose: () => void;
}

/**
 * Writes up a problem report for the user to paste wherever they report it.
 * Nothing is sent from here. The attached details are counts and switches
 * only: no URLs, file names or folders, since those can carry tokens or say
 * more about the user than a bug report needs.
 */
export default function ReportIssueDialog({ jobs, settings, onClose }: Props) {
  const [what, setWhat] = useState("");
  const [steps, setSteps] = useState("");
  const [version, setVersion] = useState("unknown");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  const details = useMemo(() => {
    const counts = new Map<JobStatus, number>();
    for (const j of jobs) counts.set(j.status, (counts.get(j.status) ?? 0) + 1);
    const byStatus = [...counts].map(([status, n]) => `${status} ${n}`).join(", ") || "none";
    const media = jobs.filter((j) => j.kind === "media").length;
    return [
      `App: NODO ${version}`,
      `System: ${navigator.userAgent}`,
      `Jobs: ${jobs.length} (${byStatus}), ${media} video`,
      `Settings: ${settings.defaultSegments} connections, ${settings.concurrency} at once, ${settings.maxRetries} retries, limit ${settings.defaultLimit || "none"}`,
      `Window: glass ${settings.glassEnabled ? `${settings.glassEffect} ${Math.round(settings.glassOpacity * 100)}%` : "off"}, island ${settings.islandEnabled ? "on" : "off"}, bridge ${settings.browserBridge ? "on" : "off"}`,
    ].join("\n");
  }, [jobs, settings, version]);

  const report = `## What happened\n${what.trim() || "-"}\n\n## Steps to reproduce\n${steps.trim() || "-"}\n\n## Details\n${details}\n`;

  async function copy() {
    await copyToClipboard(report);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Sheet onClose={onClose} label="Report an issue" className="w-[560px]">
      <div className="flex min-w-0 flex-1 flex-col bg-sheet">
        <SheetHeader title="Report an issue" subtitle="Describe the problem, then copy the report and paste it where you send feedback." onClose={onClose} />
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-7 pb-6">
          <div>
            <label htmlFor="r-what" className={LABEL}>
              What happened?
            </label>
            <textarea id="r-what" value={what} onChange={(e) => setWhat(e.currentTarget.value)} rows={4} autoFocus placeholder="The download stopped at 99% and never finished…" className={`${FIELD} h-auto resize-none py-2 leading-relaxed`} />
          </div>
          <div>
            <label htmlFor="r-steps" className={LABEL}>
              Steps to reproduce <span className="font-normal text-ink-3">(optional)</span>
            </label>
            <textarea id="r-steps" value={steps} onChange={(e) => setSteps(e.currentTarget.value)} rows={3} placeholder={"1. Paste a link from …\n2. Pause, then resume"} className={`${FIELD} h-auto resize-none py-2 leading-relaxed`} />
          </div>
          <div>
            <span className={LABEL}>Attached details</span>
            <pre className="select-text whitespace-pre-wrap break-words rounded-[10px] bg-sheet-2 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-ink-2">{details}</pre>
            <span className={HINT}>No links, file names or folders are included. Nothing is sent until you paste it somewhere yourself.</span>
          </div>
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-line px-7 py-4">
          <button type="button" onClick={onClose} className={SECONDARY_BTN}>
            Close
          </button>
          <button type="button" onClick={() => void copy()} disabled={!what.trim()} className={PRIMARY_BTN}>
            <Icon name={copied ? "check" : "copy"} className="text-base" />
            {copied ? "Copied" : "Copy report"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
