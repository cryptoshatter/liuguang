import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Task } from "./lib/api";
import { prevWorkday } from "./lib/calendar";
import { parseQuick, settle, slotAfter, pack, baseNow, fitSpan, snap, type Quick } from "./lib/plan";
import type { PlanActions } from "./lib/claude";
import { DAY_END, PM_START, dayKey, fmt, md, parseDay, parseHM, uid } from "./lib/time";

export type Cand = { id: string; title: string; minutes: number; src: string; late: boolean; pick: boolean; task: Task | null };

export type TodayApi = ReturnType<typeof useToday>;

const newTask = (day: string | null, title: string, minutes: number): Task => ({
  id: uid(),
  day,
  title,
  minutes,
  start: null,
  end: null,
  done: false,
  pinned: false,
  kind: "work",
  doneAt: null,
});

const LOG_TITLE = "写今日日志";

export function useToday(today: string, nowMin: number) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [planned, setPlanned] = useState(false);
  const [cands, setCands] = useState<Cand[]>([]);
  const [loaded, setLoaded] = useState(false);
  const undo = useRef<Task[][]>([]);

  const loadCands = useCallback(
    async (todayTasks: Task[]) => {
      const all = await api.tasksBacklog(today);
      const past = all.filter((t) => t.day && t.day < today && t.start != null && t.kind === "work");
      if (past.length) await api.tasksSave(past.map((t) => ({ ...t, done: true, doneAt: t.doneAt ?? new Date().toISOString() })));
      const back = all.filter((t) => !past.includes(t));
      const prev = dayKey(prevWorkday(parseDay(today)));
      const fromToday = todayTasks.filter((t) => !t.done && t.kind === "work");
      const list: Cand[] = [...fromToday, ...back].map((t) => {
        let src = "待办";
        let late = false;
        if (t.day === today) src = "今天没做完";
        else if (t.day === prev) {
          src = "昨天未完成";
          late = true;
        } else if (t.day) {
          src = md(parseDay(t.day)) + " 未完成";
          late = true;
        }
        return { id: t.id, title: t.title, minutes: t.minutes, src, late, pick: t.day != null, task: t };
      });
      setCands(list);
    },
    [today],
  );

  const reload = useCallback(async () => {
    const s = await api.dayState(today);
    const has = s.tasks.some((t) => t.kind === "work" && t.start != null);
    setTasks(s.tasks);
    setPlanned(s.planned || has);
    if (!s.planned && !has) await loadCands(s.tasks);
    setLoaded(true);
  }, [today, loadCands]);

  useEffect(() => {
    setLoaded(false);
    reload();
  }, [reload]);

  useEffect(() => {
    if (!loaded) return;
    const due = tasks.filter((t) => !t.done && t.start != null && t.end! <= nowMin && t.day === today && t.kind === "work");
    if (due.length) commit(due.map((t) => ({ ...t, done: true, doneAt: new Date().toISOString() })));
  }, [nowMin, loaded, tasks, today]);

  const scheduled = useMemo(() => tasks.filter((t) => t.start != null), [tasks]);
  const overflow = useMemo(() => tasks.filter((t) => t.start == null && !t.done), [tasks]);
  const base = baseNow(nowMin);

  const commit = useCallback(
    async (list: Task[]) => {
      await api.tasksSave(list);
      const s = await api.dayState(today);
      setTasks(s.tasks);
    },
    [today],
  );

  const planLines = (list: Task[]) =>
    list
      .filter((t) => !t.done && t.start != null)
      .map((t) => fmt(t.start!) + "–" + fmt(t.end!) + " " + t.title)
      .join("\n");

  const overNote = (over: Task[]) => (over.length ? "\n顺到明天：" + over.map((t) => t.title).join("、") : "");

  const notDone = async (id: string) => {
    const me = tasks.find((t) => t.id === id);
    if (!me) return "";
    const slot = slotAfter(tasks, me.minutes, Math.max(base, snap(nowMin + 2)), id);
    await commit([{ ...me, done: false, doneAt: null, start: slot?.[0] ?? null, end: slot?.[1] ?? null }]);
    return slot ? `「${me.title}」放到 ${fmt(slot[0])}–${fmt(slot[1])}。` : `「${me.title}」今天放不下，顺到明天。`;
  };

  const move = async (id: string, s: number, e: number) => {
    const r = settle(tasks, id, s, e);
    if (!r.ok) return false;
    const before = new Map(tasks.map((t) => [t.id, t]));
    const changed = r.tasks.filter((t) => before.get(t.id) !== t);
    if (!changed.length) return true;
    undo.current.push(changed.map((t) => before.get(t.id)!));
    if (undo.current.length > 30) undo.current.shift();
    setTasks(r.tasks);
    await commit(changed);
    return true;
  };

  const undoMove = async () => {
    const prev = undo.current.pop();
    if (!prev) return false;
    const ids = new Set(tasks.map((t) => t.id));
    const back = prev.filter((t) => ids.has(t.id));
    const m = new Map(back.map((t) => [t.id, t]));
    setTasks((ts) => ts.map((t) => m.get(t.id) ?? t));
    await commit(back);
    return true;
  };

  const toggle = async (id: string) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const done = !t.done;
    await commit([{ ...t, done, doneAt: done ? new Date().toISOString() : null }]);
  };

  const remove = async (id: string) => {
    await api.taskDelete(id);
    setTasks((ts) => ts.filter((t) => t.id !== id));
  };

  const addQuick = async (q: Quick) => {
    const t = newTask(today, q.title, q.minutes);
    if (q.start != null) {
      const [s, e] = fitSpan(q.start, (q.end ?? q.start + q.minutes) - q.start);
      const r = settle([...tasks, { ...t, start: s, end: e }], t.id, s, e);
      if (r.ok) {
        await commit(r.tasks.filter((x) => x.id === t.id || tasks.find((y) => y.id === x.id) !== x));
        return `「${t.title}」${fmt(s)}–${fmt(e)}。`;
      }
    }
    const slot = slotAfter(tasks, t.minutes, q.pm ? Math.max(base, PM_START) : base);
    await commit([{ ...t, start: slot?.[0] ?? null, end: slot?.[1] ?? null }]);
    return slot ? `「${t.title}」${fmt(slot[0])}–${fmt(slot[1])}。` : `「${t.title}」今天放不下，顺到明天。`;
  };

  const addText = (text: string) => addQuick(parseQuick(text));

  const ensureLog = (list: Task[]) => {
    if (list.some((t) => t.kind === "log")) return list;
    const log = newTask(today, LOG_TITLE, 20);
    log.kind = "log";
    log.start = DAY_END - 20;
    log.end = DAY_END;
    return [...list, log];
  };

  const confirmPlan = async (order?: { id: string; minutes: number }[]) => {
    const picked = cands.filter((c) => c.pick);
    const seq = order
      ? (order.map((o) => picked.find((c) => c.id === o.id) && { ...picked.find((c) => c.id === o.id)!, minutes: o.minutes }).filter(Boolean) as Cand[])
      : picked;
    const missing = picked.filter((c) => !seq.some((s) => s.id === c.id));
    const chosen = [...seq, ...missing].map((c) => ({
      ...(c.task ?? newTask(today, c.title, c.minutes)),
      day: today,
      title: c.title,
      minutes: c.minutes,
      start: null,
      end: null,
    }));
    const dropped = cands.filter((c) => !c.pick && c.task && c.task.day === today).map((c) => ({ ...c.task!, day: null, start: null, end: null }));
    const keep = ensureLog(tasks.filter((t) => t.done || t.kind !== "work")).filter((t) => t.start != null);
    const r = pack(keep, chosen, base);
    await api.tasksSave([...r.tasks, ...r.over, ...dropped]);
    await api.daySetPlanned(today, true);
    setPlanned(true);
    const s = await api.dayState(today);
    setTasks(s.tasks);
    return { picked: [...seq, ...missing], text: planLines(r.tasks) + overNote(r.over) };
  };

  const replan = async () => {
    await api.daySetPlanned(today, false);
    setPlanned(false);
    await loadCands(tasks);
  };

  const setCand = (id: string, patch: Partial<Cand>) => setCands((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const addCand = async (title: string) => {
    const q = parseQuick(title);
    const t = newTask(null, q.title, q.minutes);
    await api.tasksSave([t]);
    setCands((cs) => [...cs, { id: t.id, title: t.title, minutes: t.minutes, src: "新增", late: false, pick: true, task: t }]);
  };

  const dropCand = async (id: string) => {
    const c = cands.find((x) => x.id === id);
    if (c?.task && c.task.day !== today) await api.taskDelete(id);
    setCands((cs) => cs.filter((x) => x.id !== id));
  };

  const applyActions = async (a: PlanActions) => {
    let list = tasks.slice();
    const touched: string[] = [];
    const put = (t: Task, s: number | null, e: number | null) => {
      if (s == null) {
        const slot = slotAfter(list, t.minutes, base, t.id);
        const n = { ...t, start: slot?.[0] ?? null, end: slot?.[1] ?? null };
        list = list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? n : x)) : [...list, n];
        return;
      }
      const [fs, fe] = fitSpan(s, (e != null && e > s ? e : s + t.minutes) - s);
      const base0 = list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [...list, t];
      const r = settle(base0, t.id, fs, fe);
      if (r.ok) list = r.tasks;
      else if (!list.some((x) => x.id === t.id)) list = [...list, { ...t, start: null, end: null }];
    };
    for (const add of a.add ?? []) {
      if (!add?.title) continue;
      const t = newTask(today, String(add.title), Math.max(10, Math.round(Number(add.minutes) || 30)));
      put(t, add.start ? parseHM(add.start) : null, add.end ? parseHM(add.end) : null);
      touched.push(t.id);
    }
    for (const ed of a.edit ?? []) {
      const cur = list.find((t) => t.id === String(ed.id));
      if (!cur) continue;
      const n = { ...cur };
      if (ed.title) n.title = String(ed.title);
      const m = ed.minutes ? Math.max(10, Math.round(Number(ed.minutes))) : null;
      if (m) n.minutes = m;
      const s = ed.start ? parseHM(ed.start) : null;
      const e = ed.end ? parseHM(ed.end) : null;
      list = list.map((t) => (t.id === n.id ? n : t));
      if (s != null) put(n, s, e ?? (m ? s + m : null));
      else if (n.start != null && (e != null || m)) put(n, n.start, e != null && e > n.start ? e : n.start + n.minutes);
      touched.push(n.id);
    }
    const ids = (xs?: string[]) => new Set((xs ?? []).map(String));
    const done = ids(a.done);
    const undone = ids(a.undone);
    const rm = ids(a.remove);
    for (const id of rm) if (list.some((t) => t.id === id)) await api.taskDelete(id);
    list = list
      .filter((t) => !rm.has(t.id))
      .map((t) =>
        done.has(t.id) || done.has(t.title)
          ? { ...t, done: true, doneAt: t.doneAt ?? new Date().toISOString() }
          : undone.has(t.id)
            ? { ...t, done: false, doneAt: null }
            : t,
      );
    await commit(list);
    if (!planned && list.some((t) => t.kind === "work" && t.start != null)) {
      await api.daySetPlanned(today, true);
      setPlanned(true);
    }
    return [...touched, ...done, ...undone];
  };

  return {
    loaded,
    tasks,
    scheduled,
    overflow,
    planned,
    cands,
    base,
    reload,
    toggle,
    notDone,
    remove,
    move,
    undoMove,
    addText,
    confirmPlan,
    replan,
    setCand,
    addCand,
    dropCand,
    applyActions,
  };
}
