import type { ObItem } from "./profile";
import { md, parseDay } from "./time";

export type ObGroup = { title: string; sub: string; items: ObItem[] };

const byDue = (a: ObItem, b: ObItem) => (a.due || "9999").localeCompare(b.due || "9999");

export function groupOb(items: ObItem[]): ObGroup[] {
  const map = new Map<string, ObItem[]>();
  for (const o of [...items].sort(byDue)) {
    const k = o.group || "待办";
    map.set(k, [...(map.get(k) ?? []), o]);
  }
  return [...map.entries()].map(([title, list]) => {
    const last = list.map((o) => o.due).filter(Boolean).sort().pop();
    return { title, sub: last ? md(parseDay(last)) + " 前" : "", items: list };
  });
}

export const pendingOb = (items: ObItem[], state: Record<string, boolean>) => [...items].sort(byDue).filter((o) => !state[o.id]);
