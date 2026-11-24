import { useEffect, useState } from "react";
import { useApp } from "../ctx";
import { api } from "../lib/api";
import { HOLIDAYS, dayKind } from "../lib/calendar";
import { dayKey, daysBetween, parseDay, weekStart } from "../lib/time";
import { reportJump } from "./Report";

const CN_YEAR: Record<string, string> = { "0": "〇", "1": "一", "2": "二", "3": "三", "4": "四", "5": "五", "6": "六", "7": "七", "8": "八", "9": "九" };
const mdOf = (k: string) => {
  const d = parseDay(k);
  return d.getMonth() + 1 + "/" + d.getDate();
};

export default function Calendar() {
  const { now, settings, go, dataVersion } = useApp();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [logs, setLogs] = useState<Record<string, number>>({});

  useEffect(() => {
    const from = dayKey(new Date(ym.y, ym.m, 1));
    const to = dayKey(new Date(ym.y, ym.m + 1, 0));
    Promise.all([api.tasksRange(from, to), api.notesRange(from, to)]).then(([ts, ns]) => {
      const c: Record<string, number> = {};
      for (const t of ts) if (t.done && t.kind === "work" && t.day) c[t.day] = (c[t.day] ?? 0) + 1;
      for (const n of ns) c[n.day] = (c[n.day] ?? 0) + 1;
      setLogs(c);
    });
  }, [ym.y, ym.m, dataVersion]);

  const openWeek = (k: string) => {
    reportJump.week = weekStart(parseDay(k));
    go("log");
  };

  const years = Object.keys(HOLIDAYS).map(Number);
  const listYear = years.includes(ym.y) ? ym.y : years.find((y) => y >= now.getFullYear()) ?? years[years.length - 1];
  const hols = HOLIDAYS[listYear] ?? [];

  const first = new Date(ym.y, ym.m, 1);
  const dim = new Date(ym.y, ym.m + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  const todayKey = dayKey(now);
  let workDays = 0;
  const cells: (null | { n: number; key: string; kind: ReturnType<typeof dayKind> })[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let n = 1; n <= dim; n++) {
    const d = new Date(ym.y, ym.m, n);
    const k = dayKind(d);
    if (k.kind === "work" || k.kind === "duty") workDays++;
    cells.push({ n, key: dayKey(d), kind: k });
  }
  while (cells.length % 7) cells.push(null);

  const shift = (n: number) =>
    setYm(({ y, m }) => {
      let mm = m + n;
      let yy = y;
      if (mm < 0) {
        mm = 11;
        yy--;
      }
      if (mm > 11) {
        mm = 0;
        yy++;
      }
      return { y: yy, m: mm };
    });

  return (
    <div className="cols">
      <section className="col-wide" aria-label="月历">
        <div className="sec-head">
          <div className="baseline-row">
            <h2 className="big">
              {ym.y} 年 {ym.m + 1} 月
            </h2>
            <span className="mono small ink2">
              工作日 {workDays} · 休息 {dim - workDays}
            </span>
          </div>
          <div className="row-btns">
            <button type="button" className="sq-btn" onClick={() => shift(-1)} aria-label="上个月">
              ←
            </button>
            <button type="button" className="sq-btn" onClick={() => setYm({ y: now.getFullYear(), m: now.getMonth() })} aria-label="回到本月">
              今
            </button>
            <button type="button" className="sq-btn" onClick={() => shift(1)} aria-label="下个月">
              →
            </button>
          </div>
        </div>
        <div className="cal">
          {["一", "二", "三", "四", "五", "六", "日"].map((h) => (
            <div key={h} className="cal-head">
              {h}
            </div>
          ))}
          {cells.map((c, i) =>
            c ? (
              <button
                type="button"
                key={i}
                className={"cal-cell " + c.kind.kind + (c.key === todayKey ? " today" : "") + (c.key > todayKey ? " future" : "")}
                onClick={() => openWeek(c.key)}
                aria-label={c.key + " 这周的周报"}
              >
                <div className="cal-top">
                  <span className="cal-num">{c.n}</span>
                  {c.kind.kind === "hol" && <span className="stamp hol">休</span>}
                  {c.kind.kind === "duty" && <span className="stamp duty">班</span>}
                </div>
                <span className="cal-info">
                  {(settings["punch_in:" + c.key] || settings["punch_out:" + c.key]) && (
                    <span className="cal-punch">
                      {settings["punch_in:" + c.key] || "—"} – {settings["punch_out:" + c.key] || "—"}
                    </span>
                  )}
                  {logs[c.key] > 0 && <span className="cal-log">日志 {logs[c.key]}</span>}
                  <span className="cal-tag">{c.kind.kind === "hol" ? c.kind.name : c.kind.kind === "duty" ? c.kind.name + "调休" : ""}</span>
                </span>
              </button>
            ) : (
              <div key={i} className="cal-cell empty" />
            ),
          )}
        </div>
      </section>
      <section className="col-side" aria-label="假期">
        <h2 className="side-title">
          {String(listYear)
            .split("")
            .map((ch) => CN_YEAR[ch])
            .join("")}
          年 法定假日
        </h2>
        {hols.map((h) => {
          const from = parseDay(h.from);
          const to = parseDay(h.to);
          const days = daysBetween(from, to) + 1;
          const until = daysBetween(now, from);
          const past = daysBetween(now, to) < 0;
          return (
            <div key={h.name} className={"hol-row" + (past ? " past" : "")}>
              <div className="kv">
                <span className="serif strong">{h.name}</span>
                <span className={"mono tiny" + (!past && until <= 45 ? " red" : " ink2")}>{past ? "已过" : until <= 0 ? "放假中" : `还有 ${until} 天`}</span>
              </div>
              <div className="mono small">
                {days > 1 ? `${mdOf(h.from)} – ${mdOf(h.to)}` : mdOf(h.from)} · {days} 天
              </div>
              {h.work.length > 0 && <div className="mono small ink2">调休上班 {h.work.map(mdOf).join("、")}</div>}
            </div>
          );
        })}
        {ym.y > Math.max(...years) && <div className="small ink2 pad-y">{ym.y} 年的放假安排还没录入，只按周末显示。</div>}
      </section>
    </div>
  );
}
