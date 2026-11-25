import type { ObItem } from "./profile";

export type ObGroup = { title: string; first: string; last: string; items: ObItem[] };

const byDue = (a: ObItem, b: ObItem) => (a.due || "9999").localeCompare(b.due || "9999");

export function groupOb(items: ObItem[]): ObGroup[] {
  const map = new Map<string, ObItem[]>();
  for (const o of [...items].sort(byDue)) {
    const k = o.group || "待办";
    map.set(k, [...(map.get(k) ?? []), o]);
  }
  return [...map.entries()]
    .map(([title, list]) => {
      const dues = list.map((o) => o.due).filter(Boolean).sort();
      return { title, first: dues[0] ?? "", last: dues[dues.length - 1] ?? "", items: list };
    })
    .sort((a, b) => (a.last || "9999").localeCompare(b.last || "9999"));
}

export const pendingOb = (items: ObItem[], state: Record<string, boolean>) => [...items].sort(byDue).filter((o) => !state[o.id]);
