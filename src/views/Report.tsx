import { useCallback, useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useApp, usePanel } from "../ctx";
import { api, type Goal, type Note, type Task } from "../lib/api";
import { isWorkday } from "../lib/calendar";
import { splitJson } from "../lib/claude";
import { WD, addDays, dayKey, md, parseDay, weekStart } from "../lib/time";

const strip = (s: string) => s.replace(/[。；;，,\s]+$/, "");

export function buildReport(leader: string, from: Date, to: Date, tasks: Task[], notes: Note[], goals: Goal[]) {
  const items: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const v = strip(s);
    if (v && !seen.has(v)) {
      seen.add(v);
      items.push(v);
    }
  };
  tasks.filter((t) => t.done && t.kind === "work").forEach((t) => add(t.title));
  notes.forEach((n) => add(n.text));
  goals.forEach((g) => add("学习：" + g.title));
  const surname = leader.slice(0, 1);
  const head = `${surname}总好，同步一下我这周（${md(from)}–${md(to)}）完成的工作：`;
  if (!items.length) return head + "\n";
  return head + "\n" + items.map((s, i) => `${i + 1}. ${s}${i === items.length - 1 ? "。" : "；"}`).join("\n");
}

export default function Report() {
  const { now, today, profile, ask, toast } = useApp();
  const [week, setWeek] = useState(() => weekStart(now));
  const [tasks, setTasks] = useState<Task[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
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
    setText(rep ?? buildReport(profile.leader, firstWork, lastWork, ts, ns, wGoals));
    setCopied(false);
  }, [from, to, weekKey, profile.leader]);

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
    setText(buildReport(profile.leader, firstWork, lastWork, tasks, notes, goals));
    setCopied(false);
  };

  const polish = async () => {
    const raw = await ask(
      "帮我润色这份周报",
      `下面是我要通过微信发给${profile.leader}的周报，只写本周完成的工作。请润色成简洁、得体的一条微信消息：保留开头称呼，用编号列出完成事项，不要加学习进度、下周计划、需协助等分节，不要编造没有的内容。只输出润色后的全文，放在一个 text 代码块里。\n\n${text}`,
      { show: () => "润色好了，已经替换到周报里。不满意可以点「重新生成」。" },
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

  usePanel(
    {
      chips: [
        { label: "润色本周周报", run: polish },
        {
          label: "整理今日日志",
          run: () => {
            const t = tasks.filter((x) => x.day === today && x.done && x.kind === "work").map((x) => x.title);
            const n = notes.filter((x) => x.day === today).map((x) => x.text);
            ask("整理今日日志", `把我今天的工作整理成一段简洁的工作日志（3 到 6 条），只写项目和学习相关内容：\n完成的任务：${t.join("；") || "无"}\n随手记：${n.join("；") || "无"}`);
          },
        },
      ],
      context: () => `本周周报草稿：\n${text}`,
    },
    [text, tasks, notes],
  );

  const copy = async () => {
    await writeText(text);
    setCopied(true);
    toast("已复制，去微信粘贴给" + profile.leader);
  };

  const addNote = async () => {
    const v = noteDraft.trim();
    if (!v) return;
    await api.noteAdd(today, v);
    setNoteDraft("");
    const ns = await api.notesRange(from, to);
    setNotes(ns);
    if (saved == null) setText(buildReport(profile.leader, firstWork, lastWork, tasks, ns, goals));
  };

  const delNote = async (id: number) => {
    await api.noteDelete(id);
    const ns = await api.notesRange(from, to);
    setNotes(ns);
    if (saved == null) setText(buildReport(profile.leader, firstWork, lastWork, tasks, ns, goals));
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
            const dt = tasks.filter((t) => t.day === k && t.done && t.kind === "work");
            const dn = notes.filter((n) => n.day === k);
            const isToday = k === today;
            const empty = !dt.length && !dn.length;
            return (
              <div key={k} className="log-day">
                <div className="log-date">
                  <div className={"serif strong" + (isToday || !empty ? "" : " faint")}>{WD[d.getDay()]}</div>
                  <div className="mono tiny ink2">{md(d)}</div>
                </div>
                <div className="grow min0 log-items">
                  {dt.map((t) => (
                    <div key={t.id} className="small">
                      {t.title}
                    </div>
                  ))}
                  {dn.map((n) => (
                    <div key={n.id} className="small ink2 note-row">
                      <span className="grow">{n.text}</span>
                      <button type="button" className="x" onClick={() => delNote(n.id)} aria-label="删除这条">
                        ×
                      </button>
                    </div>
                  ))}
                  {empty && !isToday && <div className="small faint">—</div>}
                  {isToday && (
                    <form
                      className="inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        addNote();
                      }}
                    >
                      <input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="记一笔" aria-label="记一笔" />
                      <button type="submit" className="text-btn">
                        记下
                      </button>
                    </form>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="col-half report" aria-label="周报">
        <div className="sec-head">
          <h2>致 {profile.leader}</h2>
          <span className="mono small ink2">
            {md(parseDay(from))} – {md(lastWork)}
          </span>
        </div>
        <textarea
          className="ruled"
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
            让 Claude 润色
          </button>
        </div>
      </section>
    </div>
  );
}
