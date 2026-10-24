import { useEffect, useState } from "react";
import { CLIPBOARD_POLL_MS } from "../types";
import type { AppSettings, BridgeInfo, OverviewItem, ThemeMode } from "../types";
import { normalizeOverview, OVERVIEW_WIDGETS } from "./Widgets";
import { bridgeInfo } from "../lib/bridge";
import { copyToClipboard } from "../lib/jobActions";
import Icon from "./Icon";
import { FIELD, HINT, PRIMARY_BTN, SECONDARY_BTN } from "./controls";
import { SectionLabel, SettingsCard, SettingsRow, Sheet, SheetHeader, Switch } from "./Sheet";
import Select from "./Select";
import type { IconName } from "../lib/icon-data";

interface Props {
  settings: AppSettings;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
  onBrowse: () => Promise<string | null>;
  /** Applied the moment it changes, so the slider can be judged against the real window. */
  /** Page to open on. */
  initialPage?: SettingsPage;
  /** Opens the dialog that installs yt-dlp and ffmpeg for video downloads. */
  onMediaTools: () => void;
  onGlass: (patch: Partial<Pick<AppSettings, "glassEnabled" | "glassOpacity" | "glassEffect">>) => void;
  /** Applied the moment it is picked, like glass, so each choice can be seen before closing. */
  theme: ThemeMode;
  onTheme: (theme: ThemeMode) => void;
}

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/** The two palettes drawn as fixed colours: a preview must not follow the theme it previews. */
const PREVIEW = {
  light: { bg: "#e9e9e9", panel: "#ffffff", line: "#d9d9d9" },
  dark: { bg: "#0a0a0a", panel: "#212121", line: "#3a3a3a" },
};

/** A tiny window in one palette: sidebar, a pane with two lines of text and an accent bar. */
function ThemePreview({ mode, clip }: { mode: "light" | "dark"; clip?: string }) {
  const c = PREVIEW[mode];
  return (
    <div className="absolute inset-0 flex gap-1 p-1.5" style={{ background: c.bg, clipPath: clip }}>
      <div className="w-4 rounded-[4px]" style={{ background: c.panel }} />
      <div className="flex flex-1 flex-col gap-1 rounded-[5px] p-1.5" style={{ background: c.panel }}>
        <span className="h-1.5 w-3/4 rounded-full" style={{ background: c.line }} />
        <span className="h-1.5 w-1/2 rounded-full" style={{ background: c.line }} />
        <span className="mt-auto h-1.5 w-full rounded-full bg-accent" />
      </div>
    </div>
  );
}

function ThemePicker({ value, onChange }: { value: ThemeMode; onChange: (theme: ThemeMode) => void }) {
  return (
    <div role="radiogroup" aria-label="Theme" className="flex shrink-0 gap-3">
      {THEME_OPTIONS.map((o) => (
        <label key={o.value} className="group flex cursor-pointer flex-col items-center gap-1.5">
          <input type="radio" name="theme" value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="peer sr-only" />
          <span className="relative block h-[54px] w-[84px] overflow-hidden rounded-xl shadow-[0_0_0_1px_var(--line)] transition-shadow group-hover:shadow-[0_0_0_1px_var(--ink-3)] peer-checked:shadow-[0_0_0_2px_var(--accent)] peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[color-mix(in_srgb,var(--accent)_45%,transparent)]">
            {o.value === "system" ? (
              <>
                <ThemePreview mode="dark" />
                <ThemePreview mode="light" clip="polygon(0 0, 100% 0, 0 100%)" />
              </>
            ) : (
              <ThemePreview mode={o.value} />
            )}
          </span>
          <span className="text-xs text-ink-2 peer-checked:font-medium peer-checked:text-ink">{o.label}</span>
        </label>
      ))}
    </div>
  );
}

export default function SettingsModal({ settings, onClose, onSave, onBrowse, onGlass, onMediaTools, theme, onTheme, initialPage = "downloads" }: Props) {
  const [defaultSegments, setDefaultSegments] = useState(settings.defaultSegments);
  const [defaultLimit, setDefaultLimit] = useState(settings.defaultLimit);
  const [defaultOutputDir, setDefaultOutputDir] = useState(settings.defaultOutputDir);
  const [concurrency, setConcurrency] = useState(settings.concurrency);
  const [maxRetries, setMaxRetries] = useState(settings.maxRetries);
  const [userAgent, setUserAgent] = useState(settings.userAgent);
  const [clipboardMonitor, setClipboardMonitor] = useState(settings.clipboardMonitor);
  const [browserBridge, setBrowserBridge] = useState(settings.browserBridge);
  const [islandEnabled, setIslandEnabled] = useState(settings.islandEnabled);
  const [showWidgets, setShowWidgets] = useState(settings.showWidgets);
  const [bridge, setBridge] = useState<BridgeInfo | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [overview, setOverview] = useState<OverviewItem[]>(() => normalizeOverview(settings.overview));

  function moveCard(index: number, delta: number) {
    setOverview((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  // Fetched rather than passed in: the token is only ever needed on this
  // screen, so there's no reason for it to sit in app state.
  useEffect(() => {
    let active = true;
    bridgeInfo()
      .then((info) => {
        if (active) setBridge(info);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  async function handleBrowse() {
    const picked = await onBrowse();
    if (picked) setDefaultOutputDir(picked);
  }

  async function handleCopyToken() {
    if (!bridge) return;
    await copyToClipboard(bridge.token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function handleSave() {
    onSave({ ...settings, overview, defaultSegments, defaultLimit, defaultOutputDir, concurrency, maxRetries, userAgent, clipboardMonitor, browserBridge, islandEnabled, showWidgets, glassEnabled: settings.glassEnabled, glassOpacity: settings.glassOpacity, glassEffect: settings.glassEffect });
    onClose();
  }

  const nav: { page: SettingsPage; label: string; icon: IconName }[] = [
    { page: "downloads", label: "Downloads", icon: "download" },
    { page: "appearance", label: "Appearance", icon: "sun" },
    { page: "integrations", label: "Integrations", icon: "link" },
  ];
  const numberField = `${FIELD} w-24 text-right font-mono`;

  return (
    <Sheet onClose={onClose} label="Settings" className="h-[600px] w-[820px]">
      <nav aria-label="Settings sections" className="flex w-52 shrink-0 flex-col gap-1.5 border-e border-line bg-sheet-2 p-3 pt-6">
        <span className="px-2 pb-1 text-[13px] font-medium text-ink-3">Settings</span>
        {nav.map((item) => {
          const selected = item.page === page;
          return (
            <button
              key={item.page}
              type="button"
              aria-current={selected ? "page" : undefined}
              onClick={() => setPage(item.page)}
              className={`flex w-full items-center gap-2.5 rounded-[10px] p-2 text-start text-[13px] font-medium transition-colors ${
                selected ? "bg-sheet-hover text-ink" : "text-ink-2 hover:bg-sheet-hover/60 hover:text-ink"
              }`}
            >
              <Icon name={item.icon} className="text-lg text-ink-2" />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col bg-sheet">
        <SheetHeader title={nav.find((n) => n.page === page)?.label ?? "Settings"} onClose={onClose} />

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-7 pb-6">
          {page === "downloads" && (
            <>
              <section>
                <SectionLabel>Transfers</SectionLabel>
                <SettingsCard>
                  <SettingsRow label="Parallel connections" description="Segments per file when the server supports ranges." htmlFor="s-segments">
                    <input id="s-segments" type="number" min={1} max={32} value={defaultSegments} onChange={(e) => setDefaultSegments(Number(e.currentTarget.value) || 8)} className={numberField} />
                  </SettingsRow>
                  <SettingsRow label="Files at once" description="Queued files start automatically when a slot frees up." htmlFor="s-concurrency">
                    <input id="s-concurrency" type="number" min={1} max={10} value={concurrency} onChange={(e) => setConcurrency(Number(e.currentTarget.value) || 1)} className={numberField} />
                  </SettingsRow>
                  <SettingsRow label="Segment retries" description="Retries per segment, with backoff, when the connection drops." htmlFor="s-retries">
                    <input id="s-retries" type="number" min={0} max={20} value={maxRetries} onChange={(e) => setMaxRetries(Number(e.currentTarget.value) || 0)} className={numberField} />
                  </SettingsRow>
                  <SettingsRow label="Speed limit" description="Empty means unlimited, e.g. 2MB or 500KB." htmlFor="s-limit">
                    <input id="s-limit" type="text" value={defaultLimit} onChange={(e) => setDefaultLimit(e.currentTarget.value)} placeholder="Unlimited" className={`${FIELD} w-32 font-mono`} />
                  </SettingsRow>
                  <SettingsRow label="Disk pre-allocation" description="Space is reserved before the first byte arrives.">
                    <span className="rounded-full bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] px-2.5 py-1 text-xs font-medium text-ok-text">Always on</span>
                  </SettingsRow>
                </SettingsCard>
              </section>

              <section>
                <SectionLabel>Storage</SectionLabel>
                <SettingsCard>
                  <div className="py-3 pe-3">
                    <label htmlFor="s-folder" className="text-[13px] text-ink">
                      Save folder
                    </label>
                    <div className="mt-2 flex gap-2">
                      <input id="s-folder" type="text" value={defaultOutputDir} onChange={(e) => setDefaultOutputDir(e.currentTarget.value)} placeholder="Empty = app working directory" className={`${FIELD} flex-1 font-mono text-xs`} />
                      <button type="button" onClick={handleBrowse} className={SECONDARY_BTN}>
                        <Icon name="folder" className="text-base" /> Browse
                      </button>
                    </div>
                  </div>
                </SettingsCard>
              </section>

              <section>
                <SectionLabel>Advanced</SectionLabel>
                <SettingsCard>
                  <div className="py-3 pe-3">
                    <label htmlFor="s-ua" className="text-[13px] text-ink">
                      Custom User-Agent
                    </label>
                    <input id="s-ua" type="text" value={userAgent} onChange={(e) => setUserAgent(e.currentTarget.value)} placeholder="Leave empty to use the engine default" className={`${FIELD} mt-2 font-mono text-xs`} />
                    <span className={HINT}>Applies to new downloads, not ones already running.</span>
                  </div>
                </SettingsCard>
              </section>
            </>
          )}

          {page === "appearance" && (
            <>
              <section>
                <SectionLabel>Window</SectionLabel>
                <SettingsCard>
                  <SettingsRow label="Theme" description="System follows the Windows light or dark setting. Applies immediately.">
                    <ThemePicker value={theme} onChange={onTheme} />
                  </SettingsRow>
                  <SettingsRow label="Glass mode" description="Translucent window, the desktop behind it blurred by Windows. Applies immediately." htmlFor="s-glass">
                    <Switch id="s-glass" checked={settings.glassEnabled} onChange={(v) => onGlass({ glassEnabled: v })} />
                  </SettingsRow>
                  {settings.glassEnabled && (
                    <>
                      <SettingsRow label="Panel opacity" description="The minimum is 40% so text stays readable over bright wallpapers." htmlFor="glass-opacity">
                        <div className="flex w-48 items-center gap-3">
                          <input
                            id="glass-opacity"
                            type="range"
                            min={40}
                            max={100}
                            step={1}
                            value={Math.round(settings.glassOpacity * 100)}
                            onChange={(e) => onGlass({ glassOpacity: Number(e.currentTarget.value) / 100 })}
                            className="min-w-0 flex-1 accent-[var(--accent)]"
                          />
                          <span className="w-9 text-right font-mono text-xs text-ink-2">{Math.round(settings.glassOpacity * 100)}%</span>
                        </div>
                      </SettingsRow>
                      <SettingsRow label="Blur type" description="Acrylic can feel sluggish while dragging the window." htmlFor="glass-effect">
                        <Select
                          id="glass-effect"
                          className="w-44"
                          value={settings.glassEffect}
                          onChange={(v) => onGlass({ glassEffect: v as AppSettings["glassEffect"] })}
                          options={[
                            { value: "acrylic", label: "Acrylic", hint: "Strong blur, frosted desktop" },
                            { value: "mica", label: "Mica", hint: "Subtle, tinted by wallpaper" },
                          ]}
                        />
                      </SettingsRow>
                    </>
                  )}
                </SettingsCard>
              </section>

              <section>
                <SectionLabel>Layout</SectionLabel>
                <SettingsCard>
                  <SettingsRow label="Dynamic Island" description="A notch at the top of the screen while downloads run. Hides itself when idle unless pinned." htmlFor="s-island">
                    <Switch id="s-island" checked={islandEnabled} onChange={setIslandEnabled} />
                  </SettingsRow>
                  <SettingsRow label="Overview panel" description="The cards beside the list, on windows 1180px or wider." htmlFor="s-widgets">
                    <Switch id="s-widgets" checked={showWidgets} onChange={setShowWidgets} />
                  </SettingsRow>
                </SettingsCard>
              </section>

              <section>
                <SectionLabel>Overview cards</SectionLabel>
                <SettingsCard>
                  {overview.map((item, i) => {
                    const meta = OVERVIEW_WIDGETS.find((w) => w.id === item.id);
                    return (
                      <SettingsRow key={item.id} label={meta?.label ?? item.id} description={meta?.description} htmlFor={`s-ov-${item.id}`}>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <div className="flex rounded-full bg-field p-0.5">
                            <button type="button" onClick={() => moveCard(i, -1)} disabled={i === 0} aria-label={`Move ${meta?.label} up`} className={MOVE_BTN}>
                              <Icon name="chevronUp" className="text-xs" />
                            </button>
                            <button type="button" onClick={() => moveCard(i, 1)} disabled={i === overview.length - 1} aria-label={`Move ${meta?.label} down`} className={MOVE_BTN}>
                              <Icon name="chevronUp" className="rotate-180 text-xs" />
                            </button>
                          </div>
                          <Switch
                            id={`s-ov-${item.id}`}
                            checked={item.visible}
                            onChange={(v) => setOverview((prev) => prev.map((o) => (o.id === item.id ? { ...o, visible: v } : o)))}
                          />
                        </div>
                      </SettingsRow>
                    );
                  })}
                </SettingsCard>
                {!showWidgets && <p className="mt-2 px-3 text-xs text-ink-3">The Overview panel is off, so these apply once it is turned back on.</p>}
              </section>
            </>
          )}

          {page === "integrations" && (
            <>
              <section>
                <SectionLabel>Video sites</SectionLabel>
                <SettingsCard>
                  <SettingsRow label="Video downloads" description="yt-dlp and FFmpeg, for YouTube and other video pages sent from the browser extension.">
                    <button type="button" onClick={onMediaTools} className={SECONDARY_BTN}>
                      Manage
                    </button>
                  </SettingsRow>
                </SettingsCard>
              </section>

              <section>
                <SectionLabel>Clipboard</SectionLabel>
                <SettingsCard>
                  <SettingsRow
                    label="Watch clipboard"
                    description={`Offers to download copied http(s) links. Read every ${CLIPBOARD_POLL_MS / 1000} seconds, discarded if not a link, never stored or sent.`}
                    htmlFor="s-clip"
                  >
                    <Switch id="s-clip" checked={clipboardMonitor} onChange={setClipboardMonitor} />
                  </SettingsRow>
                </SettingsCard>
              </section>

              <section>
                <SectionLabel>Browser extension</SectionLabel>
                <SettingsCard>
                  <SettingsRow
                    label="Accept links from the extension"
                    description={
                      <>
                        Opens port <span className="font-mono">{bridge?.port ?? "-"}</span> on <span className="font-mono">127.0.0.1</span>, reachable only from this computer. Requests without the token are rejected.
                      </>
                    }
                    htmlFor="s-bridge"
                  >
                    <Switch id="s-bridge" checked={browserBridge} onChange={setBrowserBridge} />
                  </SettingsRow>
                  {browserBridge && (
                    <div className="py-3 pe-3">
                      <span className="text-[13px] text-ink">Pairing token</span>
                      <div className="mt-2 flex gap-2">
                        <input
                          type="text"
                          readOnly
                          aria-label="Pairing token"
                          // Masked until asked for: this is a credential, and the
                          // settings screen is exactly what ends up in a screenshot
                          // or a shared screen.
                          value={bridge ? (tokenVisible ? bridge.token : "•".repeat(32)) : "loading…"}
                          onFocus={(e) => e.currentTarget.select()}
                          className={`${FIELD} min-w-0 flex-1 truncate font-mono text-[11px]`}
                        />
                        <button type="button" onClick={() => setTokenVisible((v) => !v)} title={tokenVisible ? "Hide" : "Show"} aria-label={tokenVisible ? "Hide token" : "Show token"} className={`${SECONDARY_BTN} w-9 px-0`}>
                          <Icon name={tokenVisible ? "eyeOff" : "eye"} className="text-base" />
                        </button>
                        <button type="button" onClick={handleCopyToken} disabled={!bridge} title="Copy token" aria-label="Copy token" className={`${SECONDARY_BTN} w-9 px-0`}>
                          <Icon name={copied ? "check" : "copy"} className={`text-base ${copied ? "text-ok-text" : ""}`} />
                        </button>
                      </div>
                      <span className={HINT}>Paste this into the extension options page. Anyone on this computer with the token can add downloads.</span>
                    </div>
                  )}
                </SettingsCard>
              </section>
            </>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-line px-7 py-4">
          <button type="button" onClick={onClose} className={SECONDARY_BTN}>
            Cancel
          </button>
          <button type="button" onClick={handleSave} className={PRIMARY_BTN}>
            Save changes
          </button>
        </div>
      </div>
    </Sheet>
  );
}

export type SettingsPage = "downloads" | "appearance" | "integrations";

const MOVE_BTN = "press grid h-6 w-6 place-items-center rounded-full text-ink-2 transition-colors hover:bg-sheet hover:text-ink disabled:opacity-30";