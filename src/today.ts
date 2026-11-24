import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Task } from "./lib/api";
import { prevWorkday } from "./lib/calendar";
import { parseQuick, reflow, baseNow, type Quick } from "./lib/plan";
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

  const runReflow = useCallback(
    async (list: Task[], from = base) => {
      const r = reflow(list, from);
      await commit([...r.tasks, ...r.over]);
      return r;
    },
    [base, commit],
  );

  const planLines = (list: Task[]) =>
    list
      .filter((t) => !t.done && t.start != null)
      .map((t) => fmt(t.start!) + "–" + fmt(t.end!) + " " + t.title)
      .join("\n");

  const overNote = (over: Task[]) => (over.length ? "\n顺到明天：" + over.map((t) => t.title).join("、") : "");

  const notDone = async (id: string) => {
    const list = tasks.map((t) => (t.id === id ? { ...t, done: false, doneAt: null, pinned: false, start: null, end: null } : t));
    const r = await runReflow(list, Math.max(base, Math.ceil(nowMin / 10) * 10));
    const x = r.tasks.find((t) => t.id === id);
    const name = tasks.find((t) => t.id === id)?.title ?? "";
    return x ? `「${name}」顺到 ${fmt(x.start!)}–${fmt(x.end!)}。` : `「${name}」今天放不下，顺到明天。`;
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

  const togglePin = async (id: string) => {
    const t = tasks.find((x) => x.id === id);
    if (t) await commit([{ ...t, pinned: !t.pinned }]);
  };

  const addQuick = async (q: Quick) => {
    const t = newTask(today, q.title, q.minutes);
    if (q.start != null) {
      t.start = q.start;
      t.end = q.end ?? q.start + q.minutes;
      t.pinned = true;
    }
    const r = await runReflow([...tasks, t], q.pm ? Math.max(base, PM_START) : base);
    const placed = r.tasks.find((x) => x.id === t.id);
    const rest = r.over.filter((x) => x.id !== t.id);
    return (placed ? `「${t.title}」${fmt(placed.start!)}–${fmt(placed.end!)}。` : `「${t.title}」今天放不下，顺到明天。`) + overNote(rest);
  };

  const addText = (text: string) => addQuick(parseQuick(text));

  const reflowNow = async () => {
    const r = await runReflow(tasks);
    const lines = planLines(r.tasks);
    return (lines ? `已顺延：\n${lines}` : "没有要顺延的。") + overNote(r.over);
  };

  const ensureLog = (list: Task[]) => {
    if (list.some((t) => t.kind === "log")) return list;
    const log = newTask(today, LOG_TITLE, 20);
    log.kind = "log";
    log.pinned = true;
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
    const chosen = [...seq, ...missing].map((c, i) => ({
      ...(c.task ?? newTask(today, c.title, c.minutes)),
      day: today,
      title: c.title,
      minutes: c.minutes,
      start: 2000 + i,
      end: 2000 + i + c.minutes,
      pinned: false,
    }));
    const dropped = cands.filter((c) => !c.pick && c.task && c.task.day === today).map((c) => ({ ...c.task!, day: null, start: null, end: null }));
    const keep = tasks.filter((t) => t.done || t.kind !== "work" || (t.pinned && t.start != null));
    const r = reflow(ensureLog([...keep, ...chosen]), base);
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
    const added: string[] = [];
    let needFlow = !!a.reflow;
    for (const add of a.add ?? []) {
      if (!add?.title) continue;
      const t = newTask(today, String(add.title), Math.max(10, Math.round(Number(add.minutes) || 30)));
      const s = add.start ? parseHM(add.start) : null;
      if (s != null) {
        const e = add.end ? parseHM(add.end) : null;
        t.start = s;
        t.end = e != null && e > s ? e : s + t.minutes;
        t.minutes = t.end - s;
        t.pinned = true;
      } else needFlow = true;
      added.push(t.id);
      list.push(t);
    }
    for (const ed of a.edit ?? []) {
      list = list.map((t) => {
        if (t.id !== String(ed.id)) return t;
        const n = { ...t };
        if (ed.title) n.title = String(ed.title);
        if (ed.pinned != null) n.pinned = !!ed.pinned;
        const s = ed.start ? parseHM(ed.start) : null;
        const e = ed.end ? parseHM(ed.end) : null;
        const m = ed.minutes ? Math.max(10, Math.round(Number(ed.minutes))) : null;
        if (m) n.minutes = m;
        if (s != null) {
          n.start = s;
          n.end = e != null && e > s ? e : s + n.minutes;
          n.minutes = n.end - s;
          n.pinned = ed.pinned ?? true;
        } else if (e != null && n.start != null && e > n.start) {
          n.end = e;
          n.minutes = e - n.start;
        } else if (m && n.start != null) {
          n.end = n.start + m;
          needFlow = true;
        }
        added.push(n.id);
        return n;
      });
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
    if (needFlow) {
      const r = reflow(list, base);
      list = [...r.tasks, ...r.over];
    }
    await commit(list);
    if (!planned && list.some((t) => t.kind === "work" && t.start != null)) {
      await api.daySetPlanned(today, true);
      setPlanned(true);
    }
    return [...added, ...done, ...undone];
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
    togglePin,
    addText,
    reflowNow,
    confirmPlan,
    replan,
    setCand,
    addCand,
    dropCand,
    applyActions,
  };
}
