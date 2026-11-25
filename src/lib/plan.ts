import type { Task } from "./api";
import { AM_START, DAY_END, LUNCH_START, PM_START, parseHM } from "./time";

export const SNAP = 5;
export const MIN_LEN = 10;

export const baseNow = (n: number) => {
  const b = n < AM_START || n >= DAY_END - 20 ? AM_START : n;
  return Math.ceil(b / SNAP) * SNAP;
};

export const snap = (m: number) => Math.round(m / SNAP) * SNAP;

type Span = [number, number];

const hitOf = (spans: Span[], s: number, e: number) => spans.find((f) => s < f[1] && e > f[0]);

const freeFrom = (spans: Span[], x: number, d: number) => {
  for (let guard = 0; guard < 200; guard++) {
    const hit = hitOf(spans, x, x + d);
    if (!hit) break;
    x = hit[1];
  }
  return x;
};

export function fitSpan(s: number, d: number): Span {
  d = Math.max(MIN_LEN, d);
  const mid = (LUNCH_START + PM_START) / 2;
  if (s + d / 2 < mid) {
    d = Math.min(d, LUNCH_START - AM_START);
    s = Math.max(AM_START, Math.min(s, LUNCH_START - d));
  } else {
    d = Math.min(d, DAY_END - PM_START);
    s = Math.max(PM_START, Math.min(s, DAY_END - d));
  }
  return [s, s + d];
}

export function settle(list: Task[], id: string, s: number, e: number): { tasks: Task[]; ok: boolean } {
  const me = list.find((t) => t.id === id);
  if (!me) return { tasks: list, ok: false };
  const moved: Task = { ...me, start: s, end: e, minutes: e - s };
  const fixed: Span[] = list.filter((t) => t.id !== id && t.done && t.start != null).map((t) => [t.start!, t.end!]);
  fixed.push([LUNCH_START, PM_START]);
  let ok = s >= AM_START && e <= DAY_END && !hitOf(fixed, s, e);
  const spans: Span[] = [...fixed, [s, e]];
  const rest = list.filter((t) => t.id !== id && !t.done && t.start != null).sort((a, b) => a.start! - b.start!);
  const out = new Map<string, Task>([[id, moved]]);
  for (const t of rest) {
    const d = t.end! - t.start!;
    let x = t.start!;
    if (hitOf(spans, x, x + d)) {
      const first = hitOf(spans, x, x + d)!;
      x = freeFrom(spans, Math.max(x, first[1]), d);
    }
    if (x + d > DAY_END) ok = false;
    spans.push([x, x + d]);
    out.set(t.id, x === t.start ? t : { ...t, start: x, end: x + d });
  }
  return { tasks: list.map((t) => out.get(t.id) ?? t), ok };
}

export function slotAfter(list: Task[], d: number, from: number, skip?: string): Span | null {
  const spans: Span[] = list.filter((t) => t.id !== skip && t.start != null).map((t) => [t.start!, t.end!]);
  spans.push([LUNCH_START, PM_START]);
  d = Math.max(MIN_LEN, d);
  const x = freeFrom(spans, Math.max(AM_START, from), d);
  return x + d > DAY_END ? null : [x, x + d];
}

export function pack(keep: Task[], list: Task[], from: number): { tasks: Task[]; over: Task[] } {
  const placed: Task[] = keep.slice();
  const over: Task[] = [];
  for (const t of list) {
    const slot = slotAfter(placed, t.minutes, from);
    if (slot) placed.push({ ...t, start: slot[0], end: slot[1] });
    else over.push({ ...t, start: null, end: null });
  }
  return { tasks: placed, over };
}

export type Quick = { title: string; minutes: number; start?: number; end?: number; pm?: boolean };

export function parseQuick(text: string): Quick {
  const m = text.match(/^(\d{1,2}[:：]\d{2})\s*[-–~到至]\s*(\d{1,2}[:：]\d{2})\s*(.+)$/);
  if (m) {
    const s = parseHM(m[1]);
    const e = parseHM(m[2]);
    if (s != null && e != null && e > s) return { title: m[3].trim(), minutes: e - s, start: s, end: e };
  }
  let minutes = 30;
  let rest = text;
  const dm = rest.match(/\s*(\d+(?:\.\d+)?)\s*(分钟|min|小时|h)\s*$/i);
  if (dm) {
    const v = parseFloat(dm[1]);
    minutes = /小时|h/i.test(dm[2]) ? Math.round(v * 60) : Math.round(v);
    rest = rest.slice(0, dm.index).trim();
  }
  const one = rest.match(/^(\d{1,2}[:：]\d{2})\s*(.+)$/);
  if (one) {
    const s = parseHM(one[1]);
    const len = dm ? minutes : 60;
    if (s != null) return { title: one[2].trim(), minutes: len, start: s, end: s + len };
  }
  const title = rest.replace(/^(帮我)?(下午|上午)?(再)?(加|新增|添加)(一个|一项|个)?/, "").trim() || rest;
  return { title, minutes, pm: /^(帮我)?下午/.test(text) };
}
