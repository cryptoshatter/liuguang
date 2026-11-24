export const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export let AM_START = 540;
export let LUNCH_START = 720;
export let PM_START = 810;
export let DAY_END = 1080;

export const DEFAULT_HOURS = { work_start: "9:00", lunch_start: "12:00", lunch_end: "13:30", work_end: "18:00" };

export function applyHours(s: Record<string, string>) {
  const g = (k: keyof typeof DEFAULT_HOURS) => parseHM(s[k] || "") ?? parseHM(DEFAULT_HOURS[k])!;
  const a = g("work_start");
  const l = g("lunch_start");
  const p = g("lunch_end");
  const e = g("work_end");
  if (a < l && l <= p && p < e) {
    AM_START = a;
    LUNCH_START = l;
    PM_START = p;
    DAY_END = e;
  }
}

export const pad = (n: number) => (n < 10 ? "0" : "") + n;

export const fmt = (m: number) => Math.floor(m / 60) + ":" + pad(m % 60);

export const dur = (m: number) => {
  if (m < 60) return m + " 分钟";
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h + " 小时" + (r ? " " + r + " 分" : "");
};

export const dayKey = (d: Date) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

export const parseDay = (k: string) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export const weekStart = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));

export const md = (d: Date) => d.getMonth() + 1 + "/" + d.getDate();

export const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();

export const daysBetween = (a: Date, b: Date) => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86400000);

export const parseHM = (s: string): number | null => {
  const m = s.trim().match(/^(\d{1,2})[:：](\d{2})$/);
  if (!m) return null;
  const v = +m[1] * 60 + +m[2];
  return v >= 0 && v < 1440 ? v : null;
};

export const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
