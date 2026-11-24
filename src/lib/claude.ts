import type { Task } from "./api";
import { dayKindLabel } from "./calendar";
import type { Profile } from "./profile";
import { AM_START, DAY_END, LUNCH_START, PM_START, WD, dayKey, fmt, pad } from "./time";

export type { Profile } from "./profile";

export const preamble = (p: Profile, now: Date) =>
  [
    `你是${p.name || "用户"}的工作助手，嵌在 Mac 应用「流光」里，能直接操作流光里的所有数据。`,
    [p.project && `所在项目：${p.project}。`, p.leader && `周报发给：${p.leader}。`, p.joinDate && `入职日期：${p.joinDate}。`, p.about && `关于我：${p.about}`]
      .filter(Boolean)
      .join(""),
    `现在是 ${dayKey(now)} ${WD[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}，${dayKindLabel(now)}。作息：${fmt(AM_START)} 上班，${fmt(LUNCH_START)}–${fmt(PM_START)} 午休，${fmt(DAY_END)} 下班。`,
    "你的风格像一个沉默办事的秘书：直接给结果，一两句话说完。不寒暄，不复述问题，不解释过程，不说「好的」「当然」，不追问，不列建议清单。能直接改的就直接改，改完只说改了什么。用中文，纯文本，不用 Markdown 标题、加粗、表格。",
  ]
    .filter(Boolean)
    .join("\n");

export const taskLines = (tasks: Task[]) =>
  tasks.length
    ? tasks
        .map((t) => `- [${t.done ? "x" : " "}] ${t.start != null ? fmt(t.start) + "–" + fmt(t.end!) : "未排"} ${t.title}（${t.minutes} 分钟，id=${t.id}${t.pinned ? "，固定" : ""}${t.kind !== "work" ? "，" + t.kind : ""}）`)
        .join("\n")
    : "（还没有任务）";

export const ACTIONS_PROTOCOL = `需要改动数据时，在回答最后附一个 json 代码块 {"actions":[...]}，按顺序执行。可用动作：
{"do":"task.add","title":"任务名","minutes":60,"start":"15:00","day":"YYYY-MM-DD"}  day 省略为今天；start 省略时自动排进今天的空档
{"do":"task.edit","id":"任务id","title":"新名字","minutes":30,"start":"10:00","end":"11:00","pinned":true}  只写要改的字段
{"do":"task.done","id":"任务id","done":true}
{"do":"task.remove","id":"任务id"}
{"do":"task.reflow"}  今天没做完的从现在起往后顺排
{"do":"plan.redo"}  重新定今日任务
{"do":"log.add","day":"YYYY-MM-DD","items":["一条日志"]}  给某天记或补日志
{"do":"log.remove","id":12}
{"do":"report.set","week":"该周周一 YYYY-MM-DD","text":"周报全文"}
{"do":"ob.add","title":"事项","hint":"怎么办","due":"YYYY-MM-DD","group":"分组"}
{"do":"ob.edit","id":"事项id","title":"","hint":"","due":"","group":""}
{"do":"ob.done","id":"事项id","done":true}
{"do":"ob.remove","id":"事项id"}
{"do":"goal.add","title":"目标","stage":0}  stage 省略为当前阶段
{"do":"goal.done","id":"目标id","done":true}
{"do":"goal.remove","id":"目标id"}
{"do":"stages.set","stages":[{"name":"阶段名","weeks":2,"why":"为什么学","topics":["要点"]}]}  整条学习路线替换
{"do":"stage.current","index":0}
{"do":"punch","which":"in","time":"9:01"}  which 为 in 或 out
{"do":"mail.draft","reply":true,"to":"","cc":"","subject":"","body":"正文"}  只填进写信框，由用户自己点发送；reply 为 true 时回复正在看的邮件，可省略 to 和 subject
{"do":"setting","key":"user_name|leader_name|project_name|join_date|about|report_head|work_start|lunch_start|lunch_end|work_end","value":"值"}
{"do":"links.set","links":[{"label":"名字","url":"https://..."}]}
{"do":"go","view":"today|cal|log|onboard|mail|learn|settings"}
规则：时间流只放项目工作；日志和周报只记项目工作和学习，不写入职手续和个人事务；不编造用户没说过的工作内容；不需要改动就不附代码块。`;

export type PlanActions = {
  add?: { title: string; minutes?: number; start?: string; end?: string }[];
  edit?: { id: string; title?: string; minutes?: number; start?: string; end?: string; pinned?: boolean }[];
  done?: string[];
  undone?: string[];
  remove?: string[];
  reflow?: boolean;
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

export const redact = (s: string) => s.replace(/((?:初始)?密码\s*[：:]\s*)[^\s，,。；;、]+/g, "$1【已隐藏】");
