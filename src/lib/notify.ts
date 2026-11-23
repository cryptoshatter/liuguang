import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

let granted: boolean | null = null;

export async function ensureNotify() {
  if (granted != null) return granted;
  granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  return granted;
}

export async function notify(body: string) {
  if (await ensureNotify().catch(() => false)) sendNotification({ title: "流光 · 打卡", body });
}
