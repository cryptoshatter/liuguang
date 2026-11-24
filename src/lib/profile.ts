export type Profile = { name: string; leader: string; project: string; joinDate: string; about: string; reportHead: string };
export type Link = { label: string; url: string };
export type ObItem = { id: string; group: string; title: string; hint: string; due: string };
export type Stage = { name: string; weeks: number; why: string; topics: string[] };

export const DEFAULT_REPORT_HEAD = "{leader}，同步一下我这周（{range}）完成的工作：";

const json = <T,>(s: string | undefined, d: T): T => {
  if (!s) return d;
  try {
    const v = JSON.parse(s);
    return Array.isArray(d) && !Array.isArray(v) ? d : v;
  } catch {
    return d;
  }
};

export const readProfile = (s: Record<string, string>): Profile => ({
  name: s.user_name || "",
  leader: s.leader_name || "",
  project: s.project_name || "",
  joinDate: /^\d{4}-\d{2}-\d{2}$/.test(s.join_date || "") ? s.join_date : "",
  about: s.about || "",
  reportHead: s.report_head || DEFAULT_REPORT_HEAD,
});

export const readLinks = (s: Record<string, string>) => json<Link[]>(s.links, []).filter((l) => l && l.url);

export const readObItems = (s: Record<string, string>) =>
  json<ObItem[]>(s.ob_items, [])
    .filter((o) => o && o.id && o.title)
    .map((o) => ({ ...o, group: o.group || "", hint: o.hint || "", due: o.due || "" }));

export const readStages = (s: Record<string, string>) =>
  json<Stage[]>(s.learn_stages, [])
    .filter((x) => x && x.name)
    .map((x) => ({ name: x.name, weeks: Number(x.weeks) || 1, why: x.why || "", topics: Array.isArray(x.topics) ? x.topics : [] }));

export const SETTING_KEYS = [
  "user_name",
  "leader_name",
  "project_name",
  "join_date",
  "about",
  "report_head",
  "work_start",
  "lunch_start",
  "lunch_end",
  "work_end",
  "links",
  "ob_items",
  "learn_stages",
  "learn_stage",
  "learn_plan",
  "auto_update",
];

export async function importBundle(
  text: string,
  set: (k: string, v: string) => Promise<unknown>,
  markDone: (id: string) => Promise<unknown>,
  doneNow: Record<string, boolean>,
) {
  const b = JSON.parse(text);
  if (!b || typeof b !== "object" || typeof b.settings !== "object") throw new Error("不是流光的配置文件");
  let n = 0;
  for (const [k, v] of Object.entries(b.settings as Record<string, unknown>)) {
    if (!SETTING_KEYS.includes(k)) continue;
    await set(k, typeof v === "string" ? v : JSON.stringify(v));
    n++;
  }
  for (const id of Array.isArray(b.onboardingDone) ? b.onboardingDone : []) if (!(id in doneNow)) await markDone(String(id));
  return n;
}
