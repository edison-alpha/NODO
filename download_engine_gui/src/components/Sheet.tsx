import { useEffect } from "react";
import type { ReactNode } from "react";
import Icon from "./Icon";
import { ICON_BTN } from "./controls";

/** A centred modal panel over a dimmed window. Escape and a backdrop click close it. */
export function Sheet({ onClose, className = "", label, children }: { onClose: () => void; className?: string; label: string; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      <button type="button" aria-label="Close" tabIndex={-1} onClick={onClose} className="backdrop-in absolute inset-0 cursor-default bg-black/55" />
      <div role="dialog" aria-modal="true" aria-label={label} className={`modal sheet-in relative flex max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] overflow-hidden rounded-3xl ${className}`}>
        {children}
      </div>
    </div>
  );
}

/** Title row with the round close button, as on BoardUI sheets. */
export function SheetHeader({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose: () => void }) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-4 px-7 pb-3 pt-7">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[13px] text-ink-3">{subtitle}</p>}
      </div>
      <button type="button" onClick={onClose} className={`${ICON_BTN} mt-1`} aria-label={`Close ${title}`}>
        <Icon name="close" className="text-sm" />
      </button>
    </div>
  );
}

/** Muted heading above a grouped card. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="mb-2 px-3 text-[13px] font-medium text-ink-3">{children}</p>;
}

/** A grouped card. The left padding lives here so row dividers stop short of the edge. */
export function SettingsCard({ children }: { children: ReactNode }) {
  return <div className="flex w-full flex-col rounded-2xl bg-sheet-2 ps-3.5">{children}</div>;
}

/** One label + control row. Rows separate themselves; the last has no divider. */
export function SettingsRow({ label, description, children, htmlFor }: { label: string; description?: ReactNode; children?: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex min-h-[52px] w-full items-center justify-between gap-4 border-b border-line py-2.5 pe-3 last:border-b-0">
      <label htmlFor={htmlFor} className="flex min-w-0 flex-col">
        <span className="text-[13px] text-ink">{label}</span>
        {description && <span className="mt-0.5 text-xs leading-relaxed text-ink-3">{description}</span>}
      </label>
      {children}
    </div>
  );
}

export function Switch({ checked, onChange, id, label }: { checked: boolean; onChange: (value: boolean) => void; id?: string; label?: string }) {
  return <input id={id} type="checkbox" role="switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} className="switch" />;
}
