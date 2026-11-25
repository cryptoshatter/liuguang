import { api, type Task } from "./api";
import { HOLIDAYS } from "./calendar";
import type { MailDraft, View } from "../ctx";
import type { PlanActions } from "./claude";
import { taskLines } from "./claude";
import type { Link, ObItem, Profile, Stage } from "./profile";
import type { TodayApi } from "../today";
import { WD, addDays, dayKey, parseDay, parseHM, uid, weekStart } from "./time";

const VIEW_NAME: Record<View, string> = { today: "今日", cal: "日历", log: "周报", onboard: "入职清单", mail: "邮箱", learn: "学习路线", settings: "设置" };

export type StateInput = {
  now: Date;
  today: string;
  view: View;
  profile: Profile;
  settings: Record<string, string>;
  todayApi: TodayApi;
  obItems: ObItem[];
  obState: Record<string, boolean>;
  stages: Stage[];
  links: Link[];
  focus: string;
};

export async function gatherState(s: StateInput) {
  const from = dayKey(addDays(parseDay(s.today), -21));
  const to = dayKey(addDays(parseDay(s.today), 7));
  const wk = dayKey(weekStart(s.now));
  const [tasks, notes, backlog, goals, report] = await Promise.all([
    api.tasksRange(from, to),
    api.notesRange(from, to),
    api.tasksBacklog(s.today),
    api.goalsList(),
    api.reportGet(wk),
  ]);
  const cache = new Map<string, Task>();
  [...tasks, ...backlog, ...s.todayApi.tasks].forEach((t) => cache.set(t.id, t));

  const days: string[] = [];
  for (let d = parseDay(from); dayKey(d) <= s.today; d = addDays(d, 1)) {
    const k = dayKey(d);
    const dt = tasks.filter((t) => t.day === k && t.done && t.kind === "work").map((t) => t.title);
    const dn = notes.filter((n) => n.day === k).map((n) => `[id=${n.id}] ${n.text}`);
    days.push(`${k} ${WD[d.getDay()]}：${[...dt.map((x) => "完成任务 " + x), ...dn].join("；") || "无"}`);
  }

  const future = tasks.filter((t) => t.day && t.day > s.today && !t.done);
  const pending = [...backlog.filter((t) => t.day !== s.today), ...future];
  const cur = Number(s.settings.learn_stage ?? 0) || 0;
  const hol = Object.values(HOLIDAYS)
    .flat()
    .filter((h) => h.to >= s.today)
    .slice(0, 3)
    .map((h) => `${h.name} ${h.from}~${h.to}${h.work.length ? " 调休上班 " + h.work.join("、") : ""}`);

  const parts = [
    `【当前页面】${VIEW_NAME[s.view]}`,
    s.focus && `【正在看】\n${s.focus}`,
    `【今天的时间流】${s.todayApi.planned ? "" : "（今日任务还没定）"}\n${taskLines(s.todayApi.tasks)}`,
    pending.length && `【其他待办】\n${pending.map((t) => `- ${t.title}（${t.day ?? "未定日期"}，id=${t.id}）`).join("\n")}`,
    `【最近三周日志】\n${days.join("\n")}`,
    `【本周周报 ${wk}】\n${report ?? "（未保存，按日志自动生成）"}`,
    `【入职清单】\n${s.obItems.length ? s.obItems.map((o) => `- [${s.obState[o.id] ? "x" : " "}] ${o.title}${o.due ? " 截止 " + o.due : ""}${o.group ? " 分组 " + o.group : ""}（id=${o.id}）`).join("\n") : "（空）"}`,
    `【学习路线】\n${
      s.stages.length
        ? s.stages.map((x, i) => `${i}. ${x.name}（${x.weeks} 周）${i === cur ? " ← 当前" : i < cur ? " 已学完" : ""}`).join("\n")
        : "（还没定）"
    }\n目标：${goals.map((g) => `[${g.done ? "x" : " "}] ${g.title}（阶段 ${g.stage}，id=${g.id}）`).join("；") || "无"}`,
    hol.length && `【近期假期】${hol.join("；")}`,
    s.links.length && `【快捷入口】${s.links.map((l) => l.label + " " + l.url).join("；")}`,
  ];
  return { text: parts.filter(Boolean).join("\n\n"), cache };
}

export type Action = Record<string, unknown> & { do: string };

export type RunDeps = {
  today: string;
  now: Date;
  todayApi: TodayApi;
  settings: Record<string, string>;
  setSetting: (k: string, v: string) => Promise<void>;
  obItems: ObItem[];
  stages: Stage[];
  cache: Map<string, Task>;
  go: (v: View) => void;
  setMailDraft: (d: MailDraft) => void;
};

const SETTABLE = new Set(["user_name", "leader_name", "project_name", "join_date", "about", "report_head", "work_start", "lunch_start", "lunch_end", "work_end"]);
const VIEWS = new Set(["today", "cal", "log", "onboard", "mail", "learn", "settings"]);
const str = (v: unknown) => (v == null ? "" : String(v)).trim();
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

export async function runActions(list: Action[], d: RunDeps): Promise<string[]> {
  const touched: string[] = [];
  const plan: PlanActions = { add: [], edit: [], done: [], undone: [], remove: [] };
  let planUsed = false;
  let redo = false;
  let ob = d.obItems.slice();
  let obDirty = false;
  let stages = d.stages.slice();
  let stagesDirty = false;
  let cur = Number(d.settings.learn_stage ?? 0) || 0;
  let curDirty = false;
  const isToday = (id: string) => d.todayApi.tasks.some((t) => t.id === id);

  for (const a of list) {
    if (!a || typeof a.do !== "string") continue;
    const id = str(a.id);
    switch (a.do) {
      case "task.add": {
        const day = str(a.day);
        if (!str(a.title)) break;
        if (!day || day === d.today) {
          plan.add!.push({ title: str(a.title), minutes: Number(a.minutes) || undefined, start: str(a.start) || undefined, end: str(a.end) || undefined });
          planUsed = true;
        } else if (isDay(day)) {
          const t: Task = { id: uid(), day, title: str(a.title), minutes: Math.max(10, Math.round(Number(a.minutes) || 30)), start: null, end: null, done: false, pinned: false, kind: "work", doneAt: null };
          await api.tasksSave([t]);
          touched.push(t.id);
        }
        break;
      }
      case "task.edit": {
        if (isToday(id)) {
          plan.edit!.push({ id, title: str(a.title) || undefined, minutes: Number(a.minutes) || undefined, start: str(a.start) || undefined, end: str(a.end) || undefined });
          planUsed = true;
        } else if (d.cache.has(id)) {
          const t = { ...d.cache.get(id)! };
          if (str(a.title)) t.title = str(a.title);
          if (Number(a.minutes)) t.minutes = Math.max(10, Math.round(Number(a.minutes)));
          if (isDay(str(a.day))) t.day = str(a.day);
          await api.tasksSave([t]);
          touched.push(id);
        }
        break;
      }
      case "task.done": {
        const on = a.done !== false;
        if (isToday(id)) {
          (on ? plan.done! : plan.undone!).push(id);
          planUsed = true;
        } else if (d.cache.has(id)) {
          const t = d.cache.get(id)!;
          await api.tasksSave([{ ...t, done: on, doneAt: on ? new Date().toISOString() : null }]);
          touched.push(id);
        }
        break;
      }
      case "task.remove":
        if (isToday(id)) {
          plan.remove!.push(id);
          planUsed = true;
        } else if (id) await api.taskDelete(id);
        break;
      case "plan.redo":
        redo = true;
        break;
      case "log.add": {
        const day = str(a.day) || d.today;
        if (!isDay(day)) break;
        const items = Array.isArray(a.items) ? a.items.map(str).filter(Boolean) : str(a.text) ? [str(a.text)] : [];
        for (const it of items) await api.noteAdd(day, it);
        if (items.length) touched.push("day:" + day);
        break;
      }
      case "log.remove":
        if (Number(a.id)) await api.noteDelete(Number(a.id));
        break;
      case "report.set": {
        const week = str(a.week) || dayKey(weekStart(d.now));
        if (isDay(week) && str(a.text)) {
          await api.reportSet(dayKey(weekStart(parseDay(week))), str(a.text));
          touched.push("report");
        }
        break;
      }
      case "ob.add": {
        if (!str(a.title)) break;
        const o: ObItem = { id: uid(), title: str(a.title), hint: str(a.hint), due: isDay(str(a.due)) ? str(a.due) : "", group: str(a.group) };
        ob.push(o);
        obDirty = true;
        touched.push(o.id);
        break;
      }
      case "ob.edit":
        ob = ob.map((o) =>
          o.id === id
            ? {
                ...o,
                title: str(a.title) || o.title,
                hint: a.hint != null ? str(a.hint) : o.hint,
                due: isDay(str(a.due)) ? str(a.due) : o.due,
                group: a.group != null ? str(a.group) : o.group,
              }
            : o,
        );
        obDirty = true;
        touched.push(id);
        break;
      case "ob.done":
        if (id) {
          await api.onboardingSet(id, a.done !== false);
          touched.push(id);
        }
        break;
      case "ob.remove":
        ob = ob.filter((o) => o.id !== id);
        obDirty = true;
        break;
      case "goal.add": {
        if (!str(a.title)) break;
        const gid = uid();
        const st = a.stage != null && Number.isFinite(Number(a.stage)) ? Number(a.stage) : cur;
        await api.goalAdd(gid, st, str(a.title));
        touched.push(gid);
        break;
      }
      case "goal.done":
        if (id) {
          await api.goalSetDone(id, a.done !== false);
          touched.push(id);
        }
        break;
      case "goal.remove":
        if (id) await api.goalDelete(id);
        break;
      case "stages.set":
        if (Array.isArray(a.stages)) {
          stages = (a.stages as Record<string, unknown>[])
            .filter((x) => x && str(x.name))
            .map((x) => ({ name: str(x.name), weeks: Math.max(1, Math.round(Number(x.weeks) || 1)), why: str(x.why), topics: Array.isArray(x.topics) ? x.topics.map(str).filter(Boolean) : [] }));
          stagesDirty = true;
          if (cur >= stages.length) {
            cur = 0;
            curDirty = true;
          }
        }
        break;
      case "stage.current": {
        const i = Math.round(Number(a.index));
        if (i >= 0 && i < Math.max(stages.length, 1)) {
          cur = i;
          curDirty = true;
        }
        break;
      }
      case "punch": {
        const which = str(a.which) === "out" ? "out" : "in";
        const t = parseHM(str(a.time));
        const v = t != null ? Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0") : String(d.now.getHours()).padStart(2, "0") + ":" + String(d.now.getMinutes()).padStart(2, "0");
        await d.setSetting(`punch_${which}:${d.today}`, v);
        break;
      }
      case "mail.draft":
        d.setMailDraft({ reply: a.reply === true || !str(a.to), to: str(a.to), cc: str(a.cc), subject: str(a.subject), body: str(a.body) });
        d.go("mail");
        break;
      case "setting": {
        const k = str(a.key);
        const v = str(a.value);
        if (!SETTABLE.has(k)) break;
        if (/^(work|lunch)_/.test(k) && parseHM(v) == null) break;
        if (k === "join_date" && v && !isDay(v)) break;
        await d.setSetting(k, v);
        break;
      }
      case "links.set":
        if (Array.isArray(a.links)) {
          const links = (a.links as Record<string, unknown>[]).filter((l) => l && str(l.url)).map((l) => ({ label: str(l.label) || str(l.url), url: str(l.url) }));
          await d.setSetting("links", JSON.stringify(links));
        }
        break;
      case "go":
        if (VIEWS.has(str(a.view))) d.go(str(a.view) as View);
        break;
    }
  }

  if (obDirty) await d.setSetting("ob_items", JSON.stringify(ob));
  if (stagesDirty) await d.setSetting("learn_stages", JSON.stringify(stages));
  if (curDirty) await d.setSetting("learn_stage", String(cur));
  if (planUsed) touched.push(...(await d.todayApi.applyActions(plan)));
  if (redo) await d.todayApi.replan();
  return touched;
}
