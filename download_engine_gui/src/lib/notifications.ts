import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

let granted: boolean | null = null;

/** Caches the permission check so each notify call doesn't re-prompt. */
async function ensureNotificationPermission(): Promise<boolean> {
  if (granted !== null) return granted;
  granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === "granted";
  }
  return granted;
}

export async function notifyDownloadComplete(name: string) {
  if (!(await ensureNotificationPermission())) return;
  sendNotification({ title: "Download complete", body: name });
}

export async function notifyDownloadFailed(name: string, error: string) {
  if (!(await ensureNotificationPermission())) return;
  sendNotification({ title: "Download failed", body: `${name}\n${error}` });
}
