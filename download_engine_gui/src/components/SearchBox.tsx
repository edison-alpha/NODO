import { useEffect, useMemo, useRef, useState } from "react";
import type { Ref } from "react";
import type { Job } from "../types";
import { hostOf } from "../lib/ui";
import Icon from "./Icon";
import FileThumb from "./FileThumb";

const RECENT_KEY = "search-recent";
const MAX_RECENT = 6;
const MAX_RESULTS = 6;

function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function writeRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Recents are a convenience; losing them is fine.
  }
}

/** The name with the matched part in bold, the way Explorer highlights a hit. */
function Highlight({ text, query }: { text: string; query: string }) {
  const i = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="font-semibold text-ink">{text.slice(i, i + query.length)}</span>
      {text.slice(i + query.length)}
    </>
  );
}

type Row = { kind: "recent"; query: string } | { kind: "job"; job: Job };

interface Props {
  value: string;
  onChange: (value: string) => void;
  jobs: Job[];
  /** Opens the details pane for a download picked from the dropdown. */
  onOpenJob: (id: string) => void;
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * Search field in the File Explorer style: a filled box with no border, and a
 * dropdown under it. Empty, it offers recent searches and the latest
 * downloads; while typing, the downloads that match. The list behind it
 * filters live either way, so the dropdown is a shortcut, not the only way in.
 */
export default function SearchBox({ value, onChange, jobs, onOpenJob, inputRef }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const root = useRef<HTMLDivElement>(null);
  const query = value.trim();

  const latest = useMemo(() => [...jobs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 4), [jobs]);
  const matches = useMemo(() => {
    if (!query) return [];
    const q = query.toLowerCase();
    return jobs.filter((j) => j.name.toLowerCase().includes(q) || j.url.toLowerCase().includes(q)).slice(0, MAX_RESULTS);
  }, [jobs, query]);

  const rows: Row[] = query ? matches.map((job) => ({ kind: "job", job })) : [...recent.map((q) => ({ kind: "recent" as const, query: q })), ...latest.map((job) => ({ kind: "job" as const, job }))];

  useEffect(() => setActive(-1), [query, open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  function remember(q: string) {
    const term = q.trim();
    if (!term) return;
    const next = [term, ...recent.filter((r) => r.toLowerCase() !== term.toLowerCase())].slice(0, MAX_RECENT);
    setRecent(next);
    writeRecent(next);
  }

  function forget(q: string) {
    const next = recent.filter((r) => r !== q);
    setRecent(next);
    writeRecent(next);
  }

  function choose(row: Row) {
    if (row.kind === "recent") {
      onChange(row.query);
      remember(row.query);
      return;
    }
    remember(query);
    onOpenJob(row.job.id);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(-1, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0 && rows[active]) choose(rows[active]);
      else {
        // Enter on the text itself keeps the filter and files it under recents.
        remember(query);
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (open) setOpen(false);
      else if (value) onChange("");
      else e.currentTarget.blur();
    }
  }

  const section = "px-2.5 pb-1 pt-2 text-[11px] font-medium text-ink-3";
  const rowBase = "flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-[13px]";
  let index = -1;

  return (
    <div ref={root} className="relative ml-auto w-72">
      <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-base text-ink-3" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => {
          onChange(e.currentTarget.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search downloads"
        aria-label="Search downloads"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        className="h-9 w-full rounded-full bg-raised pl-9 pr-8 text-ink outline-none transition-colors placeholder:text-ink-3 select-text focus:bg-[color-mix(in_srgb,var(--raised)_70%,var(--ink)_8%)] [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          onClick={() => {
            onChange("");
            setOpen(true);
          }}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-surface hover:text-ink"
        >
          <Icon name="close" className="text-xs" />
        </button>
      )}

      {open && rows.length + (query ? 1 : 0) > 0 && (
        <div className="modal sheet-in absolute right-0 top-full z-[60] mt-2 w-[360px] origin-top-right rounded-2xl p-1.5" role="listbox" aria-label="Search suggestions">
          {query ? (
            matches.length > 0 ? (
              <p className={section}>Downloads</p>
            ) : (
              <p className="px-2.5 py-3 text-[13px] text-ink-3">No downloads match “{query}”.</p>
            )
          ) : (
            recent.length > 0 && (
              <div className="flex items-center justify-between">
                <p className={section}>Recent searches</p>
                <button
                  onClick={() => {
                    setRecent([]);
                    writeRecent([]);
                  }}
                  className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-accent-text hover:underline"
                >
                  Clear
                </button>
              </div>
            )
          )}

          {rows.map((row) => {
            index += 1;
            const i = index;
            const header = !query && row.kind === "job" && i === recent.length ? <p className={section}>Latest downloads</p> : null;
            if (row.kind === "recent")
              return (
                <div
                  key={`r-${row.query}`}
                  role="option"
                  aria-selected={active === i}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(row);
                  }}
                  className={`${rowBase} group/row ${active === i ? "bg-raised" : ""}`}
                >
                  <Icon name="history" className="shrink-0 text-base text-ink-3" />
                  <span className="min-w-0 flex-1 truncate text-ink-2">{row.query}</span>
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      forget(row.query);
                    }}
                    aria-label={`Remove ${row.query} from recent searches`}
                    className="grid h-5 w-5 place-items-center rounded-full text-ink-3 opacity-0 hover:bg-surface hover:text-ink group-hover/row:opacity-100"
                  >
                    <Icon name="close" className="text-[10px]" />
                  </button>
                </div>
              );
            return (
              <div key={`j-${row.job.id}`}>
                {header}
                <div
                  role="option"
                  aria-selected={active === i}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(row);
                  }}
                  className={`${rowBase} ${active === i ? "bg-raised" : ""}`}
                >
                  <FileThumb name={row.job.name} path={row.job.outputPath} done={row.job.status === "completed"} category={row.job.category} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink-2">
                      <Highlight text={row.job.name} query={query} />
                    </span>
                    <span className="block truncate text-[11px] text-ink-3">{hostOf(row.job.url)}</span>
                  </span>
                  <Icon name="arrowUpRight" className="shrink-0 text-sm text-ink-3" />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
