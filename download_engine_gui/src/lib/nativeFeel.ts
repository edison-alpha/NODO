/**
 * Turns off the parts of the webview that give away that this is a web page:
 * the browser context menu, reload and print shortcuts, page zoom, the find
 * bar and caret browsing. Inputs keep their own context menu (cut, copy,
 * paste) since that is what a native text box offers too.
 */

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["checkbox", "radio", "range", "button", "submit"].includes(type);
}

/** Shortcuts a browser handles and a desktop app shouldn't. */
function isBrowserShortcut(e: KeyboardEvent): boolean {
  const key = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  // Reload stays available while developing.
  if (!import.meta.env.DEV && (key === "f5" || (mod && key === "r"))) return true;
  if (key === "f3" || key === "f7") return true; // find next, caret browsing
  if (mod && ["p", "f", "g", "u", "s", "j", "h", "+", "=", "-", "0"].includes(key)) return true;
  // Back and forward through history.
  if (e.altKey && (key === "arrowleft" || key === "arrowright")) return true;
  return false;
}

export function installNativeFeel() {
  document.addEventListener("contextmenu", (e) => {
    if (!isEditable(e.target)) e.preventDefault();
  });

  document.addEventListener(
    "keydown",
    (e) => {
      if (isBrowserShortcut(e)) e.preventDefault();
    },
    { capture: true },
  );

  // Ctrl + wheel would zoom the whole page.
  document.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false },
  );

  // Dropping a file or link the app doesn't handle would navigate away.
  document.addEventListener("dragover", (e) => e.preventDefault());

  // Mouse back/forward buttons.
  window.addEventListener("mouseup", (e) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  });
}
