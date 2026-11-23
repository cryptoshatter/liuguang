import type { Task } from "./api";
import { dayKindLabel } from "./calendar";
import { WD, dayKey, fmt, pad } from "./time";

export type Profile = { name: string; leader: string; project: string };

export const preamble = (p: Profile, now: Date) =>
  [
    `你是${p.name}的工作助手，嵌在 Mac 应用「流光」里。`,
    `${p.name}是信雅达科技的新员工（2026-11-16 入职），在${p.project}做数据开发，领导是${p.leader}，正在从 SQL 基础开始学数据开发。`,
    `现在是 ${dayKey(now)} ${WD[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}，${dayKindLabel(now)}。作息：9:00 上班，11:40–14:00 午休，18:00 下班。`,
    "用中文回答，简洁直接，不要用 Markdown 标题、加粗或表格。",
  ].join("\n");

export const taskLines = (tasks: Task[]) =>
  tasks.length
    ? tasks
        .map((t) => `- [${t.done ? "x" : " "}] ${t.start != null ? fmt(t.start) + "–" + fmt(t.end!) : "未排"} ${t.title}（${t.minutes} 分钟，id=${t.id}${t.pinned ? "，固定" : ""}）`)
        .join("\n")
    : "（还没有任务）";

export const PLAN_PROTOCOL = `如果需要改动今天的时间流，在回答最后附一个 json 代码块，格式：
\`\`\`json
{"add":[{"title":"任务名","minutes":60,"start":"15:00"}],"done":["任务id"],"remove":["任务id"],"reflow":true}
\`\`\`
add 里的 start 可省略，省略时自动排到空档；reflow 为 true 时把没做完的任务从现在开始往后顺排。时间流只放项目工作，学习和入职手续不要放进来。不需要改动就不要附代码块。`;

export type PlanActions = {
  add?: { title: string; minutes?: number; start?: string; end?: string }[];
  done?: string[];
  remove?: string[];
  reflow?: boolean;
  order?: { title: string; minutes?: number }[];
};

export function splitJson(text: string): { text: string; json: unknown | null } {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (!m) return { text: text.trim(), json: null };
  try {
    return { text: (text.slice(0, m.index) + text.slice(m.index! + m[0].length)).trim(), json: JSON.parse(m[1]) };
  } catch {
    return { text: text.trim(), json: null };
  }
}

export const redact = (s: string) =>
  s.replace(/((?:初始)?密码\s*[：:]\s*)[^\s，,。；;、]+/g, "$1【已隐藏】");
