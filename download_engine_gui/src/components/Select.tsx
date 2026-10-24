import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";

export interface SelectOption {
  value: string;
  label: string;
  /** Second line under the label, for options that need explaining. */
  hint?: string;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  "aria-label"?: string;
  id?: string;
  /** "field" matches the sheet inputs; "ghost" is bare text, for toolbars. */
  variant?: "field" | "ghost";
  /** Preferred side; it flips when there is no room there. */
  placement?: "bottom" | "top";
  className?: string;
}

/**
 * The app's dropdown, in place of the native <select> whose popup Windows
 * draws in its own style. Arrow keys, Enter and Escape behave as they would on
 * a native one.
 */
export default function Select({ value, options, onChange, variant = "field", placement = "bottom", className = "", id, ...aria }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // Fixed to the viewport and portalled out, so a scrolling sheet can't clip it.
  const [box, setBox] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    // Scrolling the page moves the trigger away from the list; scrolling the list itself is fine.
    const dismiss = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const r = root.current.getBoundingClientRect();
    const width = Math.max(r.width, variant === "ghost" ? 192 : 0);
    const left = Math.min(r.left, window.innerWidth - width - 8);
    const wanted = Math.min(256, options.length * 40 + 12);
    const roomBelow = window.innerHeight - r.bottom - 8;
    const up = placement === "top" ? r.top - 8 >= wanted || r.top > roomBelow : roomBelow < wanted && r.top > roomBelow;
    setBox(up ? { left, bottom: window.innerHeight - r.top + 8, width } : { left, top: r.bottom + 8, width });
  }, [open, placement, variant, options.length]);

  function show() {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }

  function pick(i: number) {
    const option = options[i];
    if (option) onChange(option.value);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // Closes the list only, not the sheet it sits in.
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  const trigger =
    variant === "field"
      ? "h-9 w-full rounded-[10px] bg-field px-3 text-[13px] text-ink ring-2 ring-inset ring-transparent hover:ring-field-ring"
      : "h-7 rounded-lg px-1 -mx-1 text-[13px] font-medium text-ink hover:bg-raised";

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        id={id}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        className={`press flex items-center justify-between gap-2 text-left outline-none transition-colors focus-visible:ring-accent ${open && variant === "field" ? "!ring-accent" : ""} ${trigger}`}
        {...aria}
      >
        <span className="truncate">{selected?.label}</span>
        <Icon name="chevronUp" className={`shrink-0 text-sm text-ink-3 transition-transform ${open ? "" : "rotate-180"}`} />
      </button>

      {open &&
        box &&
        createPortal(
        <ul
          ref={list}
          id={listId}
          role="listbox"
          style={{ left: box.left, top: box.top, bottom: box.bottom, width: box.width }}
          className={`modal sheet-in fixed z-[90] max-h-64 overflow-y-auto rounded-2xl p-1.5 ${box.bottom !== undefined ? "origin-bottom" : "origin-top"}`}
        >
          {options.map((o, i) => {
            const isSelected = o.value === value;
            return (
              <li
                key={o.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  // Before the trigger loses focus, so the pick isn't lost to the close.
                  e.preventDefault();
                  pick(i);
                }}
                className={`flex cursor-pointer items-center gap-2 rounded-[10px] px-2.5 py-2 text-[13px] ${i === active ? "bg-raised" : ""} ${isSelected ? "font-medium text-ink" : "text-ink-2"}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{o.label}</span>
                  {o.hint && <span className="block truncate text-[11px] font-normal text-ink-3">{o.hint}</span>}
                </span>
                {isSelected && <Icon name="check" className="shrink-0 text-sm text-accent-text" />}
              </li>
            );
          })}
        </ul>,
          document.body,
        )}
    </div>
  );
}
