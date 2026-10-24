import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, cursorPosition, currentMonitor, LogicalPosition } from "@tauri-apps/api/window";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import "./App.css";
import { ISLAND_ACTION_EVENT, ISLAND_FLASH_EVENT, ISLAND_STATE_EVENT } from "./types";
import type { IslandAction, IslandFlash, IslandJob, IslandState } from "./types";
import { formatBytes } from "./lib/format";
import { formatSpeed } from "./lib/ui";
import Icon from "./components/Icon";
import FileThumb from "./components/FileThumb";

const appWindow = getCurrentWindow();

/** Must match the island window in tauri.conf.json: the shape animates inside it. */
const WINDOW_WIDTH = 640;
/** Leaves room inside the window for the flared corners on both sides. */
const EXPANDED_WIDTH = 600;
/** The island hangs from the top edge of the screen, like a notch. */
const TOP_MARGIN = 0;
/** Width of the flared corners where the notch meets the screen edge. */
const EAR = 12;
const FLASH_MS = 4000;
/** Hover has to settle briefly before it opens, so a pass-through cursor does not trigger it. */
const HOVER_OPEN_MS = 90;
const HOVER_CLOSE_MS = 380;
const CURSOR_POLL_MS = 120;
/** More than this and the rest are summarised, not squeezed in. */
/** Cards per page; more than this pages sideways. */
const MAX_CARDS = 4;
/** A wheel or trackpad swipe turns at most one page per this long. */
const WHEEL_PAGE_MS = 350;
const PIN_KEY = "island-pinned";

const EMPTY: IslandState = { enabled: false, jobs: [], queued: 0, totalSpeed: 0 };

type Shape = "compact" | "flash" | "expanded";

function readPinned(): boolean {
  try {
    return localStorage.getItem(PIN_KEY) === "1";
  } catch {
    return false;
  }
}

function send(action: IslandAction) {
  void emit(ISLAND_ACTION_EVENT, action);
}

/** Overall progress of the running jobs whose size is known. */
function aggregatePct(jobs: IslandJob[]): number {
  const sized = jobs.filter((j) => j.size > 0);
  const total = sized.reduce((acc, j) => acc + j.size, 0);
  if (total <= 0) return 0;
  return Math.min(100, Math.round((sized.reduce((acc, j) => acc + j.downloaded, 0) / total) * 100));
}

function Ring({ pct, paused }: { pct: number; paused?: boolean }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r={r} fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="3" />
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        stroke={paused ? "#ff9f0a" : "#4c9bff"}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct / 100)}
        transform="rotate(-90 12 12)"
        style={{ transition: "stroke-dashoffset 300ms ease-out" }}
      />
    </svg>
  );
}

const ROUND_BTN = "grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/[0.1] text-white/85 transition-colors hover:bg-white/[0.18] hover:text-white";
const PILL = "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors";

function IslandCard({ job }: { job: IslandJob }) {
  const paused = job.status === "paused";
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-[18px] bg-white/[0.06] p-2.5 ring-1 ring-white/[0.08] ring-inset">
      <FileThumb name={job.name} path="" done={false} category={job.category} size={40} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13px] font-semibold text-white">{job.name}</span>
          <span className="shrink-0 text-xs tabular-nums text-white/60">{job.pct}%</span>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.12]">
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{ width: `${job.pct}%`, background: paused ? "#ff9f0a" : "#4c9bff" }}
          />
        </div>
        <div className="mt-1 truncate text-[11px] text-white/50">
          {paused ? "Paused" : job.speed > 0 ? formatSpeed(job.speed) : "Connecting…"}
          {job.size > 0 && ` · ${formatBytes(job.downloaded)} / ${formatBytes(job.size)}`}
        </div>
      </div>
      <button
        onClick={() => send({ type: paused ? "resume" : "pause", id: job.id })}
        aria-label={paused ? `Resume ${job.name}` : `Pause ${job.name}`}
        className={ROUND_BTN}
      >
        <Icon name={paused ? "play" : "pause"} className="text-[15px]" />
      </button>
    </div>
  );
}

/**
 * One face of the island. It lays out at its natural size and reports that
 * size, so the black shape can spring to fit while the content cross-fades
 * through a blur, the way the iOS island morphs between states.
 */
function Face({ onSize, reduced, children, width }: { onSize: (w: number, h: number) => void; reduced: boolean; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onSize(el.offsetWidth, el.offsetHeight);
    const observer = new ResizeObserver(report);
    observer.observe(el);
    report();
    return () => observer.disconnect();
  }, [onSize]);

  // Opacity and scale only: both stay on the compositor. A blur over the whole
  // face re-rasterises it every frame and was what made the morph stutter.
  const hidden = reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 };
  const shown = reduced ? { opacity: 1 } : { opacity: 1, scale: 1 };
  return (
    <motion.div
      ref={ref}
      initial={hidden}
      animate={shown}
      exit={hidden}
      transition={{ duration: reduced ? 0 : 0.24, ease: [0.32, 0.72, 0, 1] }}
      style={{ position: "absolute", top: 0, left: 0, right: 0, margin: "0 auto", width: width ?? "max-content", transformOrigin: "top center" }}
    >
      {children}
    </motion.div>
  );
}

export default function Island() {
  const [state, setState] = useState<IslandState>(EMPTY);
  const [flash, setFlash] = useState<IslandFlash | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(readPinned);
  const [page, setPage] = useState(0);
  /** Which way the last page turn went, so the new page slides in from that side. */
  const [turn, setTurn] = useState<1 | -1>(1);
  const lastWheel = useRef(0);
  const reduced = useReducedMotion() ?? false;

  // The shape's animated box. Everything else follows these three values.
  const width = useMotionValue(0);
  const height = useMotionValue(0);
  const radius = useMotionValue(24);
  const sizedOnce = useRef(false);
  const shownRef = useRef(false);
  const hoverTimer = useRef<number | undefined>(undefined);
  /** Bumped per morph, so a finished morph that was overtaken does not shrink the clip under the new one. */
  const morph = useRef(0);

  useEffect(() => {
    const unlisten = Promise.all([
      listen<IslandState>(ISLAND_STATE_EVENT, (e) => setState(e.payload)),
      listen<IslandFlash>(ISLAND_FLASH_EVENT, (e) => setFlash(e.payload)),
    ]);
    return () => {
      unlisten.then((fns) => fns.forEach((fn) => fn()));
    };
  }, []);

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const active = state.jobs;
  const visible = state.enabled && (active.length > 0 || pinned || flash !== null);

  // Centre the fixed-size window at the top of the monitor, then show it.
  useEffect(() => {
    if (visible === shownRef.current) return;
    shownRef.current = visible;
    if (!visible) {
      sizedOnce.current = false;
      setExpanded(false);
      void appWindow.hide();
      return;
    }
    void (async () => {
      const monitor = await currentMonitor();
      if (monitor) {
        const scale = monitor.scaleFactor;
        const x = monitor.position.x / scale + (monitor.size.width / scale - WINDOW_WIDTH) / 2;
        const y = monitor.position.y / scale + TOP_MARGIN;
        await appWindow.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
      }
      await appWindow.show();
    })();
  }, [visible]);

  /**
   * Sets the window's clip, which is also its hit-test area. Replacing a
   * window region makes Windows repaint the window, so this runs twice per
   * morph (a roomy clip before, the exact one after), never once per frame.
   */
  const applyShape = useCallback((w: number, h: number, r: number) => {
    const d = window.devicePixelRatio || 1;
    if (w <= 0 || h <= 0) return;
    const cw = Math.min(w, WINDOW_WIDTH - EAR * 2);
    void invoke("set_island_shape", {
      x: Math.round(((WINDOW_WIDTH - cw) / 2) * d),
      y: 0,
      // A pixel of slack so the clip never bites into the anti-aliased edge.
      width: Math.ceil(cw * d) + 1,
      height: Math.ceil(h * d) + 1,
      radius: Math.round(r * d),
      ear: Math.ceil(EAR * d),
    }).catch(() => {});
  }, []);

  // A face reports its natural size; the shape springs to it.
  const fitTo = useCallback(
    (shape: Shape) => (w: number, h: number) => {
      if (w === 0 || h === 0) return;
      const r = shape === "expanded" ? 30 : Math.min(h / 2, 18);
      const token = ++morph.current;
      if (!sizedOnce.current || reduced) {
        sizedOnce.current = true;
        width.set(w);
        height.set(h);
        radius.set(r);
        applyShape(w, h, r);
        return;
      }
      // Room for both ends of the morph plus the spring's small overshoot, so
      // nothing is clipped mid-flight; the exact clip lands once it settles.
      const roomW = Math.max(width.get(), w) * 1.03 + 4;
      const roomH = Math.max(height.get(), h) * 1.04 + 4;
      applyShape(roomW, roomH, Math.min(radius.get(), r));
      const spring = { type: "spring" as const, duration: 0.45, bounce: 0.14 };
      void Promise.all([animate(width, w, spring), animate(height, h, spring), animate(radius, r, spring)]).then(() => {
        if (token === morph.current) applyShape(w, h, r);
      });
    },
    [width, height, radius, reduced, applyShape],
  );

  // Stable per shape: a new function each render would make every Face
  // re-measure and restart the spring on each snapshot from the main window.
  const sizers = useMemo(() => ({ compact: fitTo("compact"), flash: fitTo("flash"), expanded: fitTo("expanded") }), [fitTo]);

  function cancelHover() {
    window.clearTimeout(hoverTimer.current);
  }

  function hoverIn() {
    cancelHover();
    if (expanded) return;
    hoverTimer.current = window.setTimeout(() => setExpanded(true), HOVER_OPEN_MS);
  }

  useEffect(() => cancelHover, []);

  // Closing is decided by where the cursor actually is, not by a pointer-leave
  // event: the window clip changes under the cursor as the shape animates, and
  // the webview does not reliably send a leave when that happens.
  useEffect(() => {
    // Pinning only keeps the island on screen; it still folds away once the cursor leaves.
    if (!expanded) return;
    let leaving = false;
    let busy = false;
    const timer = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const [cursor, origin] = await Promise.all([cursorPosition(), appWindow.outerPosition()]);
        const d = window.devicePixelRatio || 1;
        const w = width.get() * d;
        const h = height.get() * d;
        const left = origin.x + (WINDOW_WIDTH * d - w) / 2;
        const slack = 8 * d;
        const inside = cursor.x >= left - slack && cursor.x <= left + w + slack && cursor.y >= origin.y - slack && cursor.y <= origin.y + h + slack;
        if (inside) {
          leaving = false;
          cancelHover();
        } else if (!leaving) {
          leaving = true;
          hoverTimer.current = window.setTimeout(() => setExpanded(false), HOVER_CLOSE_MS);
        }
      } finally {
        busy = false;
      }
    }, CURSOR_POLL_MS);
    return () => {
      window.clearInterval(timer);
      cancelHover();
    };
  }, [expanded, width, height]);

  function togglePin() {
    const next = !pinned;
    setPinned(next);
    try {
      localStorage.setItem(PIN_KEY, next ? "1" : "0");
    } catch {
      // Pinning still holds for this session without storage.
    }
  }

  if (!visible) return null;

  const running = active.filter((j) => j.status === "downloading").length;
  const allPaused = active.length > 0 && running === 0;
  const pct = aggregatePct(active);
  const pages = Math.max(1, Math.ceil(active.length / MAX_CARDS));
  // Downloads finish while a later page is open; fall back to the last one left.
  const current = Math.min(page, pages - 1);
  const shown = active.slice(current * MAX_CARDS, current * MAX_CARDS + MAX_CARDS);
  // Keep every page two rows tall, so turning to a half-full last page does not resize the island.
  const filler = pages > 1 ? MAX_CARDS - shown.length : 0;

  function goTo(next: number) {
    const target = Math.max(0, Math.min(pages - 1, next));
    if (target === current) return;
    setTurn(target > current ? 1 : -1);
    setPage(target);
  }
  const shape: Shape = expanded ? "expanded" : flash ? "flash" : "compact";

  let face: ReactNode;
  if (shape === "flash" && flash) {
    const failed = flash.kind === "failed";
    face = (
      <div className="inline-flex h-11 max-w-[460px] items-center gap-2.5 px-5 text-white" role="status">
        <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${failed ? "bg-[#ff453a]" : "bg-[#30d158]"}`}>
          <Icon name={failed ? "close" : "check"} className="text-[13px] text-black" />
        </span>
        <span className="truncate text-[13px] font-semibold">{flash.name}</span>
        <span className="shrink-0 rounded-full bg-white/[0.1] px-2.5 py-1 text-[11px] font-medium text-white/75">{failed ? "Failed" : "Done"}</span>
      </div>
    );
  } else if (shape === "compact") {
    face = (
      <button
        onClick={() => setExpanded(true)}
        aria-label="Open download island"
        aria-expanded={false}
        className="inline-flex h-9 items-center gap-2.5 pl-4 pr-5 text-white"
      >
        {active.length > 0 ? <Ring pct={pct} paused={allPaused} /> : <Icon name="download" className="text-base text-white/60" />}
        <span className="whitespace-nowrap text-[13px] font-semibold">
          {active.length > 0 ? `${active.length} ${allPaused ? "paused" : active.length === 1 ? "download" : "downloads"}` : "No downloads"}
        </span>
        {running > 0 && <span className="whitespace-nowrap text-[13px] tabular-nums text-white/55">{formatSpeed(state.totalSpeed)}</span>}
      </button>
    );
  } else {
    face = (
      <div
        className="px-4 pb-4 pt-3 text-white"
        onKeyDown={(e) => {
          if (e.key === "Escape") setExpanded(false);
          else if (e.key === "ArrowRight") goTo(current + 1);
          else if (e.key === "ArrowLeft") goTo(current - 1);
        }}
      >
        <div className="flex items-center gap-2.5 pb-3">
          <img src="/nodo-mark.png" alt="" draggable={false} className="h-7 w-7 shrink-0 object-contain" />
          <span className="text-[13px] font-semibold text-white/90">
            {active.length === 0 ? "No active downloads" : `${active.length} ${active.length === 1 ? "download" : "downloads"} ${allPaused ? "paused" : "active"}`}
            {state.queued > 0 && <span className="font-normal text-white/50"> · {state.queued} queued</span>}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={() => send({ type: "openMain" })} aria-label="Open main window" title="Open main window" className={ROUND_BTN}>
              <Icon name="external" className="text-[15px]" />
            </button>
            <button
              onClick={togglePin}
              aria-pressed={pinned}
              aria-label={pinned ? "Unpin island" : "Keep island on screen"}
              title={pinned ? "Unpin: hide the island when nothing is downloading" : "Pin: keep the island on screen, even when idle"}
              className={pinned ? "grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white text-black" : ROUND_BTN}
            >
              <Icon name="pin" className="text-[15px]" />
            </button>
            <button onClick={() => setExpanded(false)} aria-label="Collapse island" title="Collapse" className={ROUND_BTN}>
              <Icon name="chevronUp" className="text-[15px]" />
            </button>
          </div>
        </div>

        {shown.length > 0 ? (
          <div
            className="overflow-hidden"
            onWheel={(e) => {
              if (pages < 2) return;
              const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
              const now = Date.now();
              if (Math.abs(delta) < 12 || now - lastWheel.current < WHEEL_PAGE_MS) return;
              lastWheel.current = now;
              goTo(current + (delta > 0 ? 1 : -1));
            }}
          >
            <motion.div
              key={current}
              initial={reduced ? false : { x: turn * 48, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ type: "spring", duration: 0.4, bounce: 0.15 }}
              className={`grid gap-2 ${shown.length > 1 || pages > 1 ? "grid-cols-2" : "grid-cols-1"}`}
            >
              {shown.map((job) => (
                <IslandCard key={job.id} job={job} />
              ))}
              {Array.from({ length: filler }, (_, i) => (
                <div key={`filler-${i}`} className="rounded-[18px] ring-1 ring-white/[0.05] ring-inset" aria-hidden="true" />
              ))}
            </motion.div>
          </div>
        ) : (
          <div className="rounded-[18px] bg-white/[0.06] px-4 py-5 text-center text-[13px] text-white/55 ring-1 ring-white/[0.08] ring-inset">
            Paste a link to start downloading, or unpin so the island hides when idle.
          </div>
        )}

        <div className="flex items-center gap-1.5 pt-3">
          <button onClick={() => send({ type: "paste" })} className={`${PILL} bg-white text-black hover:bg-white/90`}>
            <Icon name="link" className="text-[15px]" />
            Paste link
          </button>
          {active.length > 0 && (
            <button onClick={() => send({ type: allPaused ? "resumeAll" : "pauseAll" })} className={`${PILL} bg-white/[0.1] text-white hover:bg-white/[0.18]`}>
              <Icon name={allPaused ? "play" : "pause"} className="text-[15px]" />
              {allPaused ? "Resume all" : "Pause all"}
            </button>
          )}
          {pages > 1 && (
            <div className="ml-auto flex items-center gap-1" role="group" aria-label="Pages">
              <button onClick={() => goTo(current - 1)} disabled={current === 0} aria-label="Previous downloads" className={`${ROUND_BTN} disabled:opacity-30`}>
                <Icon name="chevronUp" className="-rotate-90 text-[15px]" />
              </button>
              <div className="flex items-center gap-1 px-1">
                {Array.from({ length: pages }, (_, i) => (
                  <button
                    key={i}
                    onClick={() => goTo(i)}
                    aria-label={`Page ${i + 1} of ${pages}`}
                    aria-current={i === current ? "page" : undefined}
                    className={`h-1.5 rounded-full transition-all ${i === current ? "w-4 bg-white" : "w-1.5 bg-white/30 hover:bg-white/50"}`}
                  />
                ))}
              </div>
              <button onClick={() => goTo(current + 1)} disabled={current === pages - 1} aria-label="More downloads" className={`${ROUND_BTN} disabled:opacity-30`}>
                <Icon name="chevronUp" className="rotate-90 text-[15px]" />
              </button>
            </div>
          )}
          <span className={`${pages > 1 ? "ml-2" : "ml-auto"} text-[13px] font-semibold tabular-nums ${running > 0 ? "text-white" : "text-white/45"}`}>{formatSpeed(state.totalSpeed)}</span>
        </div>
      </div>
    );
  }

  // The flared corners where the notch meets the screen edge: black everywhere
  // outside a circle centred on the ear's bottom outer corner.
  const ear = (side: "left" | "right") => (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        top: 0,
        [side]: -EAR,
        width: EAR,
        height: EAR,
        background: `radial-gradient(circle at ${side === "left" ? "0" : "100%"} 100%, transparent ${EAR - 0.5}px, #000 ${EAR}px)`,
      }}
    />
  );

  return (
    <motion.div
      onPointerEnter={hoverIn}
      initial={reduced ? false : { opacity: 0, scaleY: 0.4, scaleX: 0.7 }}
      animate={{ opacity: 1, scaleY: 1, scaleX: 1 }}
      transition={{ type: "spring", duration: 0.5, bounce: 0.25 }}
      style={{ position: "absolute", top: 0, left: "50%", x: "-50%", width, height, transformOrigin: "top center" }}
    >
      {ear("left")}
      {ear("right")}
      <motion.div
        style={{
          position: "absolute",
          inset: 0,
          borderBottomLeftRadius: radius,
          borderBottomRightRadius: radius,
          background: "#000",
          overflow: "hidden",
          boxShadow: "inset 0 -1px 0 rgba(255,255,255,0.06)",
        }}
      >
        <AnimatePresence initial={false}>
          <Face key={shape} onSize={sizers[shape]} reduced={reduced} width={shape === "expanded" ? EXPANDED_WIDTH : undefined}>
            {face}
          </Face>
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}