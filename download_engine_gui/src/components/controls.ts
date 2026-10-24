/**
 * Control styles for sheets (modals, the details drawer), after the BoardUI
 * recipes: 10px radius, filled fields with a ring instead of a border, a
 * gradient primary button, a bordered secondary one.
 */
export const LABEL = "mb-1.5 block text-[13px] font-medium text-ink";
export const FIELD =
  "h-9 w-full rounded-[10px] bg-field px-3 text-[13px] text-ink placeholder:text-ink-3 outline-none ring-2 ring-inset ring-transparent transition-shadow select-text hover:ring-field-ring focus:ring-accent";
export const HINT = "mt-1.5 block text-xs leading-relaxed text-ink-3";

const BTN = "press inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] px-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-sheet disabled:cursor-not-allowed disabled:opacity-45";
export const PRIMARY_BTN = `${BTN} btn-primary text-white`;
export const SECONDARY_BTN = `${BTN} border border-line bg-sheet text-ink shadow-[0_1px_2px_rgb(0_0_0/0.06)] hover:bg-sheet-2`;
export const GHOST_BTN = `${BTN} text-ink-2 hover:bg-sheet-hover hover:text-ink`;
export const ICON_BTN = "press grid h-6 w-6 shrink-0 place-items-center rounded-full bg-field text-ink-2 transition-colors hover:bg-sheet-hover hover:text-ink";
export const SECTION = "rounded-2xl bg-sheet-2 p-4";
