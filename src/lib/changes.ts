import type { ChangeCard, ChangeItem, Task } from "./api";
import type { Action } from "./assistant";
import type { ObItem } from "./profile";
import { fmt, md, parseDay, parseHM } from "./time";

const str = (v: unknown) => (v == null ? "" : String(v)).trim();
const span = (t?: Task) => (t && t.start != null && t.end != null ? `${fmt(t.start)}–${fmt(t.end)}` : undefined);
const dayLabel = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? md(parseDay(d)) : undefined);

export type ChangeInput = {
  acts: Action[];
  today: string;
  before: Task[];
  after: Task[];
  cache: Map<string, Task>;
  obItems: ObItem[];
};

export function describeChanges({ acts, today, before, after, cache, obItems }: ChangeInput): ChangeCard[] {
  const cards = new Map<string, ChangeItem[]>();
  const add = (view: string, it: ChangeItem) => cards.set(view, [...(cards.get(view) ?? []), it]);
  const prev = new Map(before.map((t) => [t.id, t]));
  const now = new Map(after.map((t) => [t.id, t]));
  const named = new Set<string>();

  for (const a of acts) {
    if (!a || typeof a.do !== "string") continue;
    const id = str(a.id);
    switch (a.do) {
      case "task.add": {
        const day = str(a.day);
        if (day && day !== today) {
          add("cal", { time: dayLabel(day), title: str(a.title), tag: "新增" });
          break;
        }
        const t = after.find((x) => !prev.has(x.id) && x.title === str(a.title) && !named.has(x.id));
        if (t) named.add(t.id);
        add("today", { time: span(t), title: str(a.title), tag: "新增" });
        break;
      }
      case "task.edit": {
        const t = now.get(id) ?? cache.get(id);
        if (!t) break;
        named.add(id);
        add(now.has(id) ? "today" : "cal", { time: now.has(id) ? span(t) : dayLabel(t.day ?? ""), title: t.title, tag: "修改" });
        break;
      }
      case "task.done": {
        const t = now.get(id) ?? cache.get(id);
        if (!t) break;
        named.add(id);
        add(now.has(id) ? "today" : "cal", { time: span(t), title: t.title, tag: a.done === false ? "未完成" : "完成" });
        break;
      }
      case "task.remove": {
        const t = prev.get(id) ?? cache.get(id);
        if (!t) break;
        named.add(id);
        add(prev.has(id) ? "today" : "cal", { time: span(t), title: t.title, tag: "删除" });
        break;
      }
      case "plan.redo":
        add("today", { title: "今日任务", tag: "重新定" });
        break;
      case "log.add": {
        const items = Array.isArray(a.items) ? a.items.map(str).filter(Boolean) : str(a.text) ? [str(a.text)] : [];
        for (const it of items) add("log", { time: dayLabel(str(a.day) || today), title: it, tag: "写入" });
        break;
      }
      case "log.remove":
        add("log", { title: "一条日志", tag: "删除" });
        break;
      case "report.set":
        add("log", { title: "周报", tag: "更新" });
        break;
      case "ob.add":
        add("onboard", { time: dayLabel(str(a.due)), title: str(a.title), tag: "新增" });
        break;
      case "ob.edit":
      case "ob.done":
      case "ob.remove": {
        const o = obItems.find((x) => x.id === id);
        const tag = a.do === "ob.edit" ? "修改" : a.do === "ob.remove" ? "删除" : a.done === false ? "未完成" : "完成";
        add("onboard", { time: dayLabel(o?.due ?? ""), title: str(a.title) || o?.title || "事项", tag });
        break;
      }
      case "goal.add":
        add("learn", { title: str(a.title), tag: "新增" });
        break;
      case "goal.done":
        add("learn", { title: "本周目标", tag: a.done === false ? "未完成" : "完成" });
        break;
      case "goal.remove":
        add("learn", { title: "本周目标", tag: "删除" });
        break;
      case "stages.set":
        add("learn", { title: "学习路线", tag: "更新" });
        break;
      case "stage.current":
        add("learn", { title: "当前阶段", tag: "切换" });
        break;
      case "punch":
        add("today", { time: str(a.time) || undefined, title: str(a.which) === "out" ? "下班打卡" : "上班打卡", tag: "记录" });
        break;
      case "mail.draft":
        add("mail", { title: str(a.subject) || (a.reply ? "回复邮件" : "新邮件"), tag: "待发送" });
        break;
      case "setting":
      case "links.set":
        add("settings", { title: a.do === "links.set" ? "快捷入口" : str(a.key), tag: "更新" });
        break;
    }
  }

  for (const t of after) {
    const p = prev.get(t.id);
    if (!p || named.has(t.id) || t.start == null || p.start === t.start) continue;
    add("today", { time: span(t), title: t.title, tag: p.start != null && t.start > p.start ? "顺延" : "挪动" });
  }

  return [...cards.entries()].map(([view, items]) => ({
    view,
    items: view === "today" ? items.sort((x, y) => (parseHM(x.time?.split("–")[0] ?? "") ?? 9999) - (parseHM(y.time?.split("–")[0] ?? "") ?? 9999)) : items,
  }));
}
