import { invoke } from "@tauri-apps/api/core";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "ico"]);
// What WebView2 can decode; mkv and avi fall back to the file icon.
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v"]);
// Files that carry their own icon, so each path is its own cache entry.
const OWN_ICON_EXT = new Set(["exe", "msi", "lnk", "ico", "appx", "msix"]);

export type PreviewKind = "image" | "video" | "icon";

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function previewKind(name: string): PreviewKind {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return "icon";
}

const icons = new Map<string, Promise<string | null>>();

/**
 * The Explorer icon for a file, as a data URL. A finished file with its own
 * icon (an installer, a shortcut) is asked by path; everything else by
 * extension, so one lookup serves every PDF in the list.
 */
export function fileIconUrl(name: string, path: string): Promise<string | null> {
  const ext = extOf(name);
  const byPath = path !== "" && OWN_ICON_EXT.has(ext);
  const key = byPath ? path.toLowerCase() : `*.${ext}`;
  let pending = icons.get(key);
  if (!pending) {
    pending = load(byPath ? path : `file.${ext || "bin"}`);
    icons.set(key, pending);
  }
  return pending;
}

async function load(query: string): Promise<string | null> {
  try {
    const buf = await invoke<ArrayBuffer>("file_icon", { path: query });
    const view = new DataView(buf);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buf, 8, width * height * 4), width, height), 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

const allowed = new Map<string, Promise<boolean>>();

/** Lets the webview read one finished media file through the asset protocol. */
export function allowPreview(path: string): Promise<boolean> {
  let pending = allowed.get(path);
  if (!pending) {
    pending = invoke("allow_preview", { path }).then(
      () => true,
      () => false,
    );
    allowed.set(path, pending);
  }
  return pending;
}
