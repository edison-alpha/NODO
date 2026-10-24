import { Sheet, SheetHeader } from "./Sheet";

/** What the global key handler in App.tsx does, as shown to the user. Keep the two in step. */
export const SHORTCUTS: { group: string; items: { keys: string[]; label: string }[] }[] = [
  {
    group: "Downloads",
    items: [
      { keys: ["Ctrl", "N"], label: "New download" },
      { keys: ["Ctrl", "F"], label: "Search downloads" },
    ],
  },
  {
    group: "App",
    items: [
      { keys: ["Ctrl", ","], label: "Settings" },
      { keys: ["Ctrl", "/"], label: "Keyboard shortcuts" },
      { keys: ["Esc"], label: "Close a dialog or menu" },
    ],
  },
];

export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Sheet onClose={onClose} label="Keyboard shortcuts" className="w-[440px]">
      <div className="flex min-w-0 flex-1 flex-col bg-sheet">
        <SheetHeader title="Keyboard shortcuts" onClose={onClose} />
        <div className="space-y-5 px-7 pb-7">
          {SHORTCUTS.map((section) => (
            <section key={section.group}>
              <p className="mb-2 px-3 text-[13px] font-medium text-ink-3">{section.group}</p>
              <dl className="rounded-2xl bg-sheet-2 px-3.5">
                {section.items.map((s) => (
                  <div key={s.label} className="flex min-h-11 items-center justify-between gap-4 border-b border-line last:border-b-0">
                    <dt className="text-[13px] text-ink">{s.label}</dt>
                    <dd className="flex items-center gap-1">
                      {s.keys.map((k) => (
                        <kbd key={k} className="grid h-6 min-w-6 place-items-center rounded-md bg-field px-1.5 font-sans text-xs font-medium text-ink-2 shadow-[inset_0_-1px_0_var(--line)]">
                          {k}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
