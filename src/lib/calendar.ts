import { addDays, dayKey, parseDay } from "./time";

export type Holiday = { name: string; from: string; to: string; work: string[] };

export const HOLIDAYS: Record<number, Holiday[]> = {
  2027: [
    { name: "元旦", from: "2027-01-01", to: "2027-01-03", work: [] },
    { name: "春节", from: "2027-02-05", to: "2027-02-13", work: ["2027-01-31", "2027-02-14"] },
    { name: "清明节", from: "2027-04-03", to: "2027-04-05", work: [] },
    { name: "劳动节", from: "2027-05-01", to: "2027-05-05", work: ["2027-05-08"] },
    { name: "端午节", from: "2027-06-09", to: "2027-06-09", work: [] },
    { name: "中秋节", from: "2027-09-15", to: "2027-09-15", work: [] },
    { name: "国庆节", from: "2027-10-01", to: "2027-10-07", work: ["2027-09-26", "2027-10-09"] },
  ],
};

const OFF: Record<string, string> = {};
const DUTY: Record<string, string> = {};
Object.values(HOLIDAYS)
  .flat()
  .forEach((h) => {
    for (let d = parseDay(h.from); d <= parseDay(h.to); d = addDays(d, 1)) OFF[dayKey(d)] = h.name;
    h.work.forEach((w) => (DUTY[w] = h.name));
  });

export type DayKind = { kind: "work" | "weekend" | "hol" | "duty"; name: string };

export const dayKind = (d: Date): DayKind => {
  const k = dayKey(d);
  if (OFF[k]) return { kind: "hol", name: OFF[k] };
  if (DUTY[k]) return { kind: "duty", name: DUTY[k] };
  const w = d.getDay();
  return { kind: w === 0 || w === 6 ? "weekend" : "work", name: "" };
};

export const isWorkday = (d: Date) => {
  const k = dayKind(d).kind;
  return k === "work" || k === "duty";
};

export const prevWorkday = (d: Date) => {
  let x = addDays(d, -1);
  for (let i = 0; i < 30 && !isWorkday(x); i++) x = addDays(x, -1);
  return x;
};

export const dayKindLabel = (d: Date) => {
  const k = dayKind(d);
  if (k.kind === "hol") return k.name;
  if (k.kind === "weekend") return "休息日";
  if (k.kind === "duty") return "调休上班";
  return "工作日";
};
