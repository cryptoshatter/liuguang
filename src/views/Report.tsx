import { useCallback, useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { fl, useApp, useFocus } from "../ctx";
import { api, type Goal, type Note, type Task } from "../lib/api";
import { isWorkday } from "../lib/calendar";
import { splitJson } from "../lib/claude";
import { WD, addDays, dayKey, md, parseDay, weekStart } from "../lib/time";

const strip = (s: string) => s.replace(/[。；;，,\s]+$/, "");
const norm = (s: string) => s.toLowerCase().replace(/[\s，,。.；;：:、！!？?（）()【】\[\]「」“”"'-]/g, "");

export function dedupe<T>(xs: T[], text: (x: T) => string): T[] {
  const keys = xs.map((x) => norm(text(x)));
  return xs.filter((_, i) => {
    const k = keys[i];
    if (!k) return false;
    return !keys.some((o, j) => j !== i && o.includes(k) && (o.length > k.length || j < i));
  });
}

export function buildReport(headTpl: string, leader: string, from: Date, to: Date, tasks: Task[], notes: Note[], goals: Goal[]) {
  const items = dedupe(
    [...tasks.filter((t) => t.done && t.kind === "work").map((t) => t.title), ...notes.map((n) => n.text), ...goals.map((g) => "学习：" + g.title)].map(strip),
    (x) => x,
  );
  const tpl = leader ? headTpl : headTpl.replace(/\{leader\}[，,]?\s*/g, "");
  const head = tpl.replace(/\{leader\}/g, leader).replace(/\{range\}/g, `${md(from)}–${md(to)}`);
  if (!items.length) return head + "\n";
  return head + "\n" + items.map((s, i) => `${i + 1}. ${s}${i === items.length - 1 ? "。" : "；"}`).join("\n");
}

export const reportJump: { week: Date | null } = { week: null };

export default function Report() {
  const { now, today, profile, ask, toast, dataVersion, flash } = useApp();
  const [week, setWeek] = useState(() => {
    const w = reportJump.week ?? weekStart(now);
    reportJump.week = null;
    return w;
  });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const saveTimer = useRef<number>(0);

  const weekKey = dayKey(week);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const from = dayKey(days[0]);
  const to = dayKey(days[6]);
  const lastWork = [...days].reverse().find(isWorkday) ?? days[4];
  const firstWork = days.find(isWorkday) ?? days[0];

  const load = useCallback(async () => {
    const [ts, ns, gs, rep] = await Promise.all([api.tasksRange(from, to), api.notesRange(from, to), api.goalsList(), api.reportGet(weekKey)]);
    const wGoals = gs.filter((g) => g.done && g.doneAt && g.doneAt.slice(0, 10) >= from && g.doneAt.slice(0, 10) <= to);
    setTasks(ts);
    setNotes(ns);
    setGoals(wGoals);
    setSaved(rep);
    setText(rep ?? buildReport(profile.reportHead, profile.leader, firstWork, lastWork, ts, ns, wGoals));
    setCopied(false);
  }, [from, to, weekKey, profile.leader, profile.reportHead, dataVersion]);

  useEffect(() => {
    load();
  }, [load]);

  const persist = (v: string) => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      api.reportSet(weekKey, v);
      setSaved(v);
    }, 600);
  };

  const regenerate = async () => {
    await api.reportSet(weekKey, null);
    setSaved(null);
    setText(buildReport(profile.reportHead, profile.leader, firstWork, lastWork, tasks, notes, goals));
    setCopied(false);
  };

  const polish = async () => {
    const raw = await ask(
      "帮我润色这份周报",
      `下面是我要发给${profile.leader || "领导"}的周报，只写本周完成的工作。请润色成简洁、得体的一条微信消息：保留开头称呼，用编号列出完成事项，不要加学习进度、下周计划、需协助等分节，不要编造没有的内容。只输出润色后的全文，放在一个 text 代码块里。\n\n${text}`,
      { show: () => "已替换。" },
    );
    if (!raw) return;
    const m = raw.match(/```(?:text)?\s*([\s\S]*?)```/);
    const v = (m ? m[1] : splitJson(raw).text).trim();
    if (v) {
      setText(v);
      await api.reportSet(weekKey, v);
      setSaved(v);
    }
  };

  useFocus(() => `周报页，正在看 ${from} 至 ${to} 这一周（周一 ${weekKey}）。周报${saved == null ? "（未保存，自动生成）" : ""}：\n${text}`, [text, weekKey, saved]);

  const copy = async () => {
    await writeText(text);
    setCopied(true);
    toast("已复制");
  };

  const addNote = async (day: string) => {
    const v = noteDraft.trim();
    if (!v) return;
    await api.noteAdd(day, v);
    setNoteDraft("");
    const ns = await api.notesRange(from, to);
    setNotes(ns);
    if (saved == null) setText(buildReport(profile.reportHead, profile.leader, firstWork, lastWork, tasks, ns, goals));
  };

  const delNote = async (id: number) => {
    await api.noteDelete(id);
    const ns = await api.notesRange(from, to);
    setNotes(ns);
    if (saved == null) setText(buildReport(profile.reportHead, profile.leader, firstWork, lastWork, tasks, ns, goals));
  };

  const shown = days.filter((d) => isWorkday(d) || tasks.some((t) => t.day === dayKey(d) && t.done) || notes.some((n) => n.day === dayKey(d)) || dayKey(d) === today);

  return (
    <div className="cols even">
      <section className="col-half" aria-label="本周日志">
        <div className="sec-head">
          <h2>日志</h2>
          <div className="row-btns">
            <button type="button" className="sq-btn" onClick={() => setWeek(addDays(week, -7))} aria-label="上一周">
              ←
            </button>
            <button type="button" className="sq-btn" onClick={() => setWeek(weekStart(now))} aria-label="本周">
              今
            </button>
            <button type="button" className="sq-btn" onClick={() => setWeek(addDays(week, 7))} aria-label="下一周">
              →
            </button>
          </div>
        </div>
        <div className="rule-top">
          {shown.map((d) => {
            const k = dayKey(d);
            const merged = dedupe(
              [
                ...tasks.filter((t) => t.day === k && t.done && t.kind === "work").map((t) => ({ text: t.title, task: t.id, note: 0 })),
                ...notes.filter((n) => n.day === k).map((n) => ({ text: n.text, task: "", note: n.id })),
              ],
              (x) => x.text,
            );
            const dt = merged.filter((x) => x.task);
            const dn = merged.filter((x) => x.note);
            const isToday = k === today;
            const empty = !dt.length && !dn.length;
            const open = adding === k || (adding == null && isToday);
            return (
              <div key={k} className={"log-day" + fl(flash, "day:" + k)}>
                <div className="log-date">
                  <div className={"serif strong" + (isToday || !empty ? "" : " faint")}>{WD[d.getDay()]}</div>
                  <div className="mono tiny ink2">{md(d)}</div>
                </div>
                <div className="grow min0 log-items">
                  {dt.map((t) => (
                    <div key={t.task} className="small">
                      {t.text}
                    </div>
                  ))}
                  {dn.map((n) => (
                    <div key={n.note} className="small note-row">
                      <span className="grow">{n.text}</span>
                      <button type="button" className="x" onClick={() => delNote(n.note)} aria-label="删除这条">
                        ×
                      </button>
                    </div>
                  ))}
                  {empty && !open && <div className="small faint">—</div>}
                  {open ? (
                    <form
                      className="inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        addNote(k);
                      }}
                    >
                      <input autoFocus={adding === k} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="记一笔" aria-label="记一笔" />
                      <button type="submit" className="text-btn">
                        记下
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="add-line"
                      onClick={() => {
                        setAdding(k);
                        setNoteDraft("");
                      }}
                    >
                      ＋ 记一笔
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="col-half report" aria-label="周报">
        <div className="sec-head">
          <h2>{profile.leader ? "致 " + profile.leader : "周报"}</h2>
          <span className="mono small ink2">
            {md(parseDay(from))} – {md(lastWork)}
          </span>
        </div>
        <textarea
          className={"ruled" + fl(flash, "report")}
          value={text}
          rows={12}
          onChange={(e) => {
            setText(e.target.value);
            setCopied(false);
            persist(e.target.value);
          }}
          aria-label="周报内容"
        />
        <div className="row-btns">
          <button type="button" className="btn solid" onClick={copy}>
            {copied ? "已复制" : "复制"}
          </button>
          <button type="button" className="btn ghost" onClick={regenerate}>
            重新生成
          </button>
          <button type="button" className="btn ghost" onClick={polish}>
            让 Agent 润色
          </button>
        </div>
      </section>
    </div>
  );
}
