import { useLayoutEffect, useRef, useState } from "react";
import type { IconName } from "../lib/icon-data";
import Icon from "./Icon";

export type MenuItem = { label: string; icon: IconName; run: () => void; danger?: boolean; shortcut?: string } | "separator";

const EDGE = 8;

/**
 * A menu floating at a point: where the user right-clicked, or under the
 * button that opened it. It moves itself back inside the window when it would
 * spill over an edge. `above` opens it upward from `y`, for a button at the
 * bottom of the window.
 */
export function ContextMenu({ x, y, items, onClose, above = false, label }: { x: number; y: number; items: MenuItem[]; onClose: () => void; above?: boolean; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE)),
      top: above || y + height > window.innerHeight - EDGE ? Math.max(EDGE, y - height) : y,
    });
    el.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [x, y, above]);

  function move(e: React.KeyboardEvent, delta: number) {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + delta + buttons.length) % buttons.length]?.focus();
    e.preventDefault();
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[80]"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        aria-hidden="true"
      />
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "ArrowDown") move(e, 1);
          else if (e.key === "ArrowUp") move(e, -1);
        }}
        style={{ left: pos.left, top: pos.top }}
        className={`modal sheet-in fixed z-[81] min-w-56 rounded-2xl p-1.5 ${above ? "origin-bottom-left" : "origin-top-left"}`}
      >
        {items.map((item, i) =>
          item === "separator" ? (
            <div key={`sep-${i}`} className="mx-2 my-1 h-px bg-line" role="separator" />
          ) : (
            <button
              key={item.label}
              role="menuitem"
              onClick={() => {
                onClose();
                item.run();
              }}
              className={`flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13px] outline-none transition-colors hover:bg-raised focus-visible:bg-raised ${item.danger ? "text-danger-text" : "text-ink"}`}
            >
              <Icon name={item.icon} className={`text-base ${item.danger ? "" : "text-ink-2"}`} />
              <span className="flex-1">{item.label}</span>
              {item.shortcut && <kbd className="ml-6 font-sans text-xs text-ink-3">{item.shortcut}</kbd>}
            </button>
          ),
        )}
      </div>
    </>
  );
}
