import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Job, JobStatus, OverviewItem, OverviewWidget } from "../types";
import { baseName, formatBytes } from "../lib/format";
import { formatSpeed } from "../lib/ui";
import Icon from "./Icon";
import FileThumb from "./FileThumb";

/** Seconds of history the speed chart keeps, one sample per second. */
export const SPEED_HISTORY_LEN = 60;

const DISK_REFRESH_MS = 20000;

/** The Overview cards, in their default order, with what Settings says about each. */
export const OVERVIEW_WIDGETS: { id: OverviewWidget; label: string; description: string }[] = [
  { id: "queue", label: "Queue", description: "Running, queued, failed and done, plus files at once" },
  { id: "speed", label: "Transfer speed", description: "Live speed, a speed dial and the last 60 seconds" },
  { id: "storage", label: "Storage", description: "Free space on the drive you save to" },
  { id: "recent", label: "Recently finished", description: "The last files to complete, with previews" },
];

/**
 * A saved layout made whole: every known card exactly once, in the saved
 * order, with any card added since the layout was saved appended visible.
 */
export function normalizeOverview(saved?: OverviewItem[]): OverviewItem[] {
  const known = new Set(OVERVIEW_WIDGETS.map((w) => w.id));
  const seen = new Set<OverviewWidget>();
  const out: OverviewItem[] = [];
  for (const item of saved ?? []) {
    if (known.has(item.id) && !seen.has(item.id)) {
      seen.add(item.id);
      out.push({ id: item.id, visible: item.visible !== false });
    }
  }
  for (const w of OVERVIEW_WIDGETS) if (!seen.has(w.id)) out.push({ id: w.id, visible: true });
  return out;
}

interface DiskSpace {
  total: number;
  free: number;
}

interface Props {
  speedHistory: number[];
  jobs: Job[];
  outputDir: string;
  /** How many files download at once; the rest wait in the queue. */
  concurrency: number;
  onConcurrency: (value: number) => void;
  /** Narrows the download list to one status. */
  onFilter: (status: JobStatus) => void;
  /** Shows a file or folder in Explorer. */
  onReveal: (path: string) => void;
  onChooseFolder: () => void;
  /** Which cards to show and in what order; see `normalizeOverview`. */
  layout: OverviewItem[];
  onCustomize: () => void;
}

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="card rounded-[20px] p-4" aria-label={title}>
      <header className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

const STEP_BTN = "press grid h-6 w-6 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface hover:text-ink disabled:opacity-35";
const ROW_BTN = "press flex w-full items-center gap-2.5 rounded-xl p-1.5 text-left transition-colors hover:bg-raised";

/** Round the chart ceiling up to 1, 2 or 5 times a power of ten so the axis reads cleanly. */
function niceCeil(value: number): number {
  if (value <= 0) return 1024 * 1024;
  const pow = 10 ** Math.floor(Math.log10(value));
  const n = value / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/** Catmull-Rom through the samples, as cubic Béziers, clamped so it never dips below zero. */
function smoothPath(points: [number, number][], floor: number): string {
  if (points.length < 2) return "";
  const clamp = (y: number) => Math.min(floor, y);
  let d = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = clamp(p1[1] + (p2[1] - p0[1]) / 6);
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = clamp(p2[1] - (p3[1] - p1[1]) / 6);
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

const KB = 1024;
const MB = 1024 * 1024;
/**
 * Dial stops, evenly spaced around the arc like a speed test's: the scale is
 * stretched at the low end so a 300 KB/s link still moves the needle, while
 * 100 MB/s fits on the same dial.
 */
const GAUGE_STOPS = [
  { at: 0, label: "0" },
  { at: 100 * KB, label: "100K" },
  { at: 500 * KB, label: "500K" },
  { at: 1 * MB, label: "1M" },
  { at: 5 * MB, label: "5M" },
  { at: 10 * MB, label: "10M" },
  { at: 50 * MB, label: "50M" },
  { at: 100 * MB, label: "100M" },
];
const SWEEP = 240;

/** Position of a speed on the dial, 0..1, linear between neighbouring stops. */
function gaugeFraction(v: number): number {
  const last = GAUGE_STOPS.length - 1;
  if (v <= 0) return 0;
  if (v >= GAUGE_STOPS[last].at) return 1;
  const i = GAUGE_STOPS.findIndex((s) => s.at > v);
  const lo = GAUGE_STOPS[i - 1];
  const hi = GAUGE_STOPS[i];
  return (i - 1 + (v - lo.at) / (hi.at - lo.at)) / last;
}

/** Point on a circle, angle in degrees clockwise from 12 o'clock. */
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** A small dial for the card header: the needle reads the same speed as the number beside it. */
function Gauge({ value, peak }: { value: number; peak: number }) {
  const cx = 40;
  const cy = 34;
  const r = 28;
  const start = -SWEEP / 2;
  const frac = gaugeFraction(value);
  const needle = start + frac * SWEEP;
  const peakAngle = start + gaugeFraction(peak) * SWEEP;
  const track = arcPath(cx, cy, r, start, start + SWEEP);
  const [px1, py1] = polar(cx, cy, r - 5, peakAngle);
  const [px2, py2] = polar(cx, cy, r + 5, peakAngle);

  return (
    <svg viewBox="0 0 80 52" className="-my-3 h-[44px] w-[68px] shrink-0" role="meter" aria-valuemin={0} aria-valuemax={GAUGE_STOPS[GAUGE_STOPS.length - 1].at} aria-valuenow={Math.round(value)} aria-label={`Transfer speed ${formatSpeed(value)}`}>
      <defs>
        <linearGradient id="gauge-fill" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="var(--accent)" />
        </linearGradient>
      </defs>
      <path d={track} fill="none" stroke="var(--raised)" strokeWidth="6" strokeLinecap="round" />
      <path
        d={track}
        fill="none"
        stroke="url(#gauge-fill)"
        strokeWidth="6"
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray={`${frac * 100} 100`}
        style={{ transition: "stroke-dasharray 600ms cubic-bezier(0.32, 0.72, 0, 1)", opacity: frac > 0 ? 1 : 0 }}
      />
      {peak > 0 && <line x1={px1} y1={py1} x2={px2} y2={py2} stroke="var(--ink-2)" strokeWidth="1.5" strokeLinecap="round" />}
      <g style={{ transform: `rotate(${needle}deg)`, transformOrigin: `${cx}px ${cy}px`, transition: "transform 600ms cubic-bezier(0.32, 0.72, 0, 1)" }}>
        <path d={`M${cx - 1.8} ${cy} L${cx} ${cy - r + 8} L${cx + 1.8} ${cy} Z`} fill="var(--ink)" />
      </g>
      <circle cx={cx} cy={cy} r="3.5" fill="var(--surface)" stroke="var(--ink)" strokeWidth="1.8" />
    </svg>
  );
}
function SpeedWidget({ history }: { history: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const current = history[history.length - 1] ?? 0;
  const active = history.filter((v) => v > 0);
  const peak = Math.max(...history, 0);
  const avg = active.length > 0 ? active.reduce((a, b) => a + b, 0) / active.length : 0;
  const ceiling = niceCeil(peak);
  const W = 240;
  const H = 88;
  const step = W / (SPEED_HISTORY_LEN - 1);
  const yOf = (v: number) => H - (v / ceiling) * (H - 6) - 2;
  const points = history.map((v, i) => [i * step, yOf(v)] as [number, number]);
  const line = smoothPath(points, H - 2);
  const idle = peak === 0;
  const shown = hover !== null ? history[hover] : current;

  return (
    <Card title="Transfer speed" aside={<Gauge value={shown} peak={peak} />}>
      <div className="-mt-1 mb-3 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="text-2xl font-semibold tabular-nums tracking-tight text-ink">{formatSpeed(shown)}</div>
          <div className="text-xs text-ink-3">{hover !== null ? `${SPEED_HISTORY_LEN - 1 - hover}s ago` : idle ? "Nothing transferring" : "Right now"}</div>
        </div>
        <dl className="flex gap-3 text-right text-xs">
          <div>
            <dt className="text-ink-3">Peak</dt>
            <dd className="font-medium tabular-nums text-ink-2">{formatSpeed(peak)}</dd>
          </div>
          <div>
            <dt className="text-ink-3">Avg</dt>
            <dd className="font-medium tabular-nums text-ink-2">{formatSpeed(avg)}</dd>
          </div>
        </dl>
      </div>
      <div
        className="relative h-[88px] cursor-crosshair"
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const i = Math.round(((e.clientX - rect.left) / rect.width) * (SPEED_HISTORY_LEN - 1));
          setHover(Math.max(0, Math.min(SPEED_HISTORY_LEN - 1, i)));
        }}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={idle ? "No transfer in the last 60 seconds" : `Speed ${formatSpeed(current)}, peak ${formatSpeed(peak)} in the last 60 seconds`}
      >
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="speed-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.32" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.5, 1].map((f) => (
            <line key={f} x1="0" x2={W} y1={yOf(ceiling * f)} y2={yOf(ceiling * f)} stroke="var(--line)" strokeWidth="1" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
          ))}
          {!idle && <path d={`${line} L${W} ${H} L0 ${H} Z`} fill="url(#speed-fill)" />}
          <path d={line} fill="none" stroke={idle ? "var(--ink-3)" : "var(--accent)"} strokeOpacity={idle ? 0.4 : 1} strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="pointer-events-none absolute right-0 top-0 text-[10px] tabular-nums text-ink-3">{formatBytes(ceiling, 0)}/s</span>
        {hover !== null && (
          <>
            <span className="pointer-events-none absolute inset-y-0 w-px bg-ink-3/50" style={{ left: `${(hover / (SPEED_HISTORY_LEN - 1)) * 100}%` }} />
            <span
              className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent"
              style={{ left: `${(hover / (SPEED_HISTORY_LEN - 1)) * 100}%`, top: `${(yOf(history[hover]) / H) * 100}%` }}
            />
          </>
        )}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-ink-3">
        <span>60s ago</span>
        <span>Now</span>
      </div>
    </Card>
  );
}

function StorageWidget({ dir, refreshKey, reserved, onReveal, onChooseFolder }: { dir: string; refreshKey: number; reserved: number; onReveal: (path: string) => void; onChooseFolder: () => void }) {
  const [disk, setDisk] = useState<DiskSpace | null>(null);
  const [failed, setFailed] = useState(false);
  const [focus, setFocus] = useState<"used" | "queued" | "free" | null>(null);

  useEffect(() => {
    if (!dir) return;
    let active = true;
    const read = () =>
      invoke<DiskSpace>("disk_space", { path: dir })
        .then((value) => {
          if (!active) return;
          setDisk(value);
          setFailed(false);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    void read();
    const timer = window.setInterval(() => void read(), DISK_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [dir, refreshKey]);

  const folderRow = (
    <div className="mt-3 flex items-center gap-1 border-t border-line pt-3">
      <button onClick={onChooseFolder} className={`${ROW_BTN} min-w-0 flex-1`} title={dir || "Choose a save folder"}>
        <Icon name="folder" className="text-base text-ink-2" />
        <span className="min-w-0 flex-1 truncate text-xs text-ink-2">{dir ? baseName(dir) : "Choose a save folder"}</span>
      </button>
      {dir && (
        <button onClick={() => onReveal(dir)} className="press grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-2 transition-colors hover:bg-raised hover:text-ink" aria-label="Show folder in Explorer" title="Show in Explorer">
          <Icon name="external" className="text-sm" />
        </button>
      )}
    </div>
  );

  if (!dir || failed || !disk) {
    return (
      <Card title="Storage">
        <p className={`text-xs ${failed ? "text-danger-text" : "text-ink-2"}`}>
          {!dir ? "Choose a save folder to see free space." : failed ? "Could not read disk space for this folder. Check that the drive is connected." : "Reading disk space…"}
        </p>
        {folderRow}
      </Card>
    );
  }

  // Running downloads are preallocated, so their space is already in "used";
  // only queued files with a known size are still to come out of "free".
  const used = disk.total - disk.free;
  const queued = Math.min(reserved, disk.free);
  const free = disk.free - queued;
  const tight = reserved > disk.free;
  const segments = [
    { key: "used" as const, label: "Used", value: used, color: "var(--ink-3)" },
    { key: "queued" as const, label: "Queued", value: queued, color: "var(--warn)" },
    { key: "free" as const, label: "Free", value: free, color: "var(--accent)" },
  ].filter((s) => s.key !== "queued" || s.value > 0);
  const pctUsed = Math.round((used / disk.total) * 100);

  return (
    <Card title="Storage" aside={<span className="text-xs tabular-nums text-ink-3">{pctUsed}% used</span>}>
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tabular-nums tracking-tight text-ink">{formatBytes(disk.free)}</span>
        <span className="text-xs text-ink-3">free of {formatBytes(disk.total)}</span>
      </div>

      <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`${formatBytes(used)} used, ${formatBytes(queued)} queued, ${formatBytes(free)} free`}>
        {segments.map((s) => (
          <span
            key={s.key}
            onPointerEnter={() => setFocus(s.key)}
            onPointerLeave={() => setFocus(null)}
            className="h-full rounded-full transition-opacity"
            style={{ width: `${Math.max(1.5, (s.value / disk.total) * 100)}%`, background: s.color, opacity: focus && focus !== s.key ? 0.3 : 1 }}
          />
        ))}
      </div>

      <ul className="mt-3 space-y-1">
        {segments.map((s) => (
          <li
            key={s.key}
            onPointerEnter={() => setFocus(s.key)}
            onPointerLeave={() => setFocus(null)}
            className={`flex items-center gap-2 rounded-lg px-1.5 py-1 text-xs transition-colors ${focus === s.key ? "bg-raised" : ""}`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden="true" />
            <span className="flex-1 text-ink-2">{s.label}</span>
            <span className="tabular-nums text-ink">{formatBytes(s.value)}</span>
          </li>
        ))}
      </ul>

      {tight && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-2.5 py-2 text-xs text-danger-text">
          <Icon name="warning" className="mt-0.5 text-sm" />
          Queued files need {formatBytes(reserved - disk.free)} more than is free.
        </p>
      )}
      {folderRow}
    </Card>
  );
}

const MAX_CONCURRENCY = 10;

function QueueWidget({ jobs, concurrency, onConcurrency, onFilter }: { jobs: Job[]; concurrency: number; onConcurrency: Props["onConcurrency"]; onFilter: Props["onFilter"] }) {
  const { running, queued, failed, done } = useMemo(
    () => ({
      running: jobs.filter((j) => j.status === "downloading" || j.status === "paused").length,
      queued: jobs.filter((j) => j.status === "queued").length,
      failed: jobs.filter((j) => j.status === "error").length,
      done: jobs.filter((j) => j.status === "completed").length,
    }),
    [jobs],
  );
  const tiles: { label: string; value: number; status: JobStatus; tone?: string }[] = [
    { label: "Running", value: running, status: "downloading" },
    { label: "Queued", value: queued, status: "queued" },
    { label: "Failed", value: failed, status: "error", tone: failed > 0 ? "text-danger-text" : undefined },
    { label: "Done", value: done, status: "completed", tone: done > 0 ? "text-ok-text" : undefined },
  ];

  return (
    <Card title="Queue">
      <div className="grid grid-cols-4 gap-1.5">
        {tiles.map((t) => (
          <button key={t.label} onClick={() => onFilter(t.status)} className="press rounded-xl bg-raised py-2 text-center transition-[filter] hover:brightness-125" title={`Show ${t.label.toLowerCase()}`}>
            <div className={`text-base font-semibold tabular-nums ${t.tone ?? "text-ink"}`}>{t.value}</div>
            <div className="text-[10px] text-ink-3">{t.label}</div>
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
        <span className="text-xs text-ink-2">Files at once</span>
        <div className="flex items-center gap-1 rounded-full bg-raised p-0.5" role="group" aria-label="Files downloading at once">
          <button onClick={() => onConcurrency(concurrency - 1)} disabled={concurrency <= 1} className={STEP_BTN} aria-label="Fewer files at once">
            <Icon name="minimize" className="text-xs" />
          </button>
          <span className="min-w-6 text-center text-xs font-semibold tabular-nums text-ink" aria-live="polite">
            {concurrency}
          </span>
          <button onClick={() => onConcurrency(concurrency + 1)} disabled={concurrency >= MAX_CONCURRENCY} className={STEP_BTN} aria-label="More files at once">
            <Icon name="plus" className="text-xs" />
          </button>
        </div>
      </div>
    </Card>  );
}

function RecentWidget({ jobs, onReveal, onFilter }: { jobs: Job[]; onReveal: Props["onReveal"]; onFilter: Props["onFilter"] }) {
  const recent = useMemo(
    () =>
      jobs
        .filter((j) => j.status === "completed" && j.outputPath)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 4),
    [jobs],
  );
  if (recent.length === 0) return null;

  return (
    <Card
      title="Recently finished"
      aside={
        <button onClick={() => onFilter("completed")} className="text-xs font-medium text-accent-text hover:underline">
          See all
        </button>
      }
    >
      <ul>
        {recent.map((j) => (
          <li key={j.id}>
            <button onClick={() => onReveal(j.outputPath)} className={ROW_BTN} title="Show in Explorer">
              <FileThumb name={j.name} path={j.outputPath} done category={j.category} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-ink">{j.name}</span>
                <span className="block text-[11px] tabular-nums text-ink-3">{formatBytes(j.sizeBytes || j.downloadedBytes)}</span>
              </span>
              <Icon name="folder" className="shrink-0 text-sm text-ink-3" />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function Widgets({ speedHistory, jobs, outputDir, concurrency, onConcurrency, onFilter, onReveal, onChooseFolder, layout, onCustomize }: Props) {
  // A finished download changes the free space, so re-read it right then.
  const completed = useMemo(() => jobs.filter((j) => j.status === "completed").length, [jobs]);
  const reserved = useMemo(() => jobs.filter((j) => j.status === "queued" && j.sizeBytes > 0).reduce((acc, j) => acc + j.sizeBytes, 0), [jobs]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 pb-3">
      {layout.map((item) => {
        if (!item.visible) return null;
        switch (item.id) {
          case "queue":
            return <QueueWidget key="queue" jobs={jobs} concurrency={concurrency} onConcurrency={onConcurrency} onFilter={onFilter} />;
          case "speed":
            return <SpeedWidget key="speed" history={speedHistory} />;
          case "storage":
            return <StorageWidget key="storage" dir={outputDir} refreshKey={completed} reserved={reserved} onReveal={onReveal} onChooseFolder={onChooseFolder} />;
          case "recent":
            return <RecentWidget key="recent" jobs={jobs} onReveal={onReveal} onFilter={onFilter} />;
        }
      })}
      {layout.every((item) => !item.visible) && (
        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <p className="text-xs text-ink-3">Every Overview card is turned off.</p>
          <button onClick={onCustomize} className="press rounded-full bg-raised px-3.5 py-1.5 text-xs font-medium text-ink transition-[filter] hover:brightness-125">
            Choose cards
          </button>
        </div>
      )}
    </div>
  );
}
