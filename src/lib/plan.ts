import type { Task } from "./api";
import { AM_START, DAY_END, LUNCH_START, PM_START, parseHM } from "./time";

export const baseNow = (n: number) => {
  const b = n < AM_START || n >= DAY_END - 20 ? AM_START : n;
  return Math.ceil(b / 10) * 10;
};

export function reflow(list: Task[], base: number): { tasks: Task[]; over: Task[] } {
  const keep = list.filter((t) => t.start != null && (t.done || t.pinned));
  const fixed: [number, number][] = keep.map((t) => [t.start!, t.end!]);
  fixed.push([LUNCH_START, PM_START]);
  const mov = list
    .filter((t) => !t.done && !(t.pinned && t.start != null))
    .sort((a, b) => (a.start ?? 99999) - (b.start ?? 99999));
  const out = keep.slice();
  const over: Task[] = [];
  for (const t of mov) {
    const d = Math.max(10, t.minutes);
    let x = base;
    for (let guard = 0; guard < 80; guard++) {
      const hit = fixed.find((f) => x < f[1] && x + d > f[0]);
      if (!hit) break;
      x = hit[1];
    }
    if (x + d > DAY_END) {
      over.push({ ...t, start: null, end: null });
      continue;
    }
    out.push({ ...t, start: x, end: x + d });
    fixed.push([x, x + d]);
  }
  out.sort((a, b) => a.start! - b.start!);
  return { tasks: out, over };
}

export type Quick = { title: string; minutes: number; start?: number; end?: number; pm?: boolean };

export function parseQuick(text: string): Quick {
  const m = text.match(/^(\d{1,2}[:：]\d{2})\s*[-–~到至]\s*(\d{1,2}[:：]\d{2})\s*(.+)$/);
  if (m) {
    const s = parseHM(m[1]);
    const e = parseHM(m[2]);
    if (s != null && e != null && e > s) return { title: m[3].trim(), minutes: e - s, start: s, end: e };
  }
  const one = text.match(/^(\d{1,2}[:：]\d{2})\s+(.+)$/);
  if (one) {
    const s = parseHM(one[1]);
    if (s != null) return { title: one[2].trim(), minutes: 60, start: s, end: s + 60 };
  }
  let minutes = 30;
  let rest = text;
  const dm = rest.match(/\s*(\d+(?:\.\d+)?)\s*(分钟|min|小时|h)\s*$/i);
  if (dm) {
    const v = parseFloat(dm[1]);
    minutes = /小时|h/i.test(dm[2]) ? Math.round(v * 60) : Math.round(v);
    rest = rest.slice(0, dm.index).trim();
  }
  const title = rest.replace(/^(帮我)?(下午|上午)?(再)?(加|新增|添加)(一个|一项|个)?/, "").trim() || rest;
  return { title, minutes, pm: /^(帮我)?下午/.test(text) };
}
