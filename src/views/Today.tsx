import { useState } from "react";
import { useApp, usePanel } from "../ctx";
import Check from "../components/Check";
import { ONBOARDING_ITEMS } from "../lib/onboarding";
import { AM_START, DAY_END, LUNCH_START, PM_START, daysBetween, dur, fmt, md, minutesOf, pad, parseDay } from "../lib/time";

const px = (m: number) => ((Math.max(AM_START, Math.min(DAY_END, m)) - AM_START) * 80) / 60 + 10;

const MARKS: [number, string][] = [
  [AM_START, "上班"],
  [LUNCH_START, "午饭"],
  [PM_START, "下午上班"],
  [DAY_END, "下班"],
];

export default function Today({ obState }: { obState: Record<string, boolean> }) {
  const { now, today, todayApi: t, go, ask, say, settings, setSetting, openClaude } = useApp();
  const [quick, setQuick] = useState("");
  const nowMin = minutesOf(now);

  const seg = nowMin < AM_START ? "pre" : nowMin < LUNCH_START ? "am" : nowMin < PM_START ? "lunch" : nowMin < DAY_END ? "pm" : "off";
  const next = MARKS.find((m) => m[0] > nowMin);
  const countdown = next ? `距${next[1]} ${dur(next[0] - nowMin)}` : "已下班";
  const worked = Math.min(Math.max(nowMin, AM_START), LUNCH_START) - AM_START + (Math.min(Math.max(nowMin, PM_START), DAY_END) - PM_START);
  const workPct = Math.round((worked / (LUNCH_START - AM_START + DAY_END - PM_START)) * 100);

  const status = (x: (typeof t.scheduled)[number]) =>
    x.done ? "done" : nowMin >= x.start! && nowMin < x.end! ? "now" : nowMin >= x.end! ? "late" : "todo";
  const cur = t.scheduled.find((x) => status(x) === "now");
  const late = t.scheduled.filter((x) => status(x) === "late");
  const workTasks = t.tasks.filter((x) => x.kind === "work");
  const doneCount = workTasks.filter((x) => x.done).length;

  let curTitle: string;
  let curSub = "";
  if (!t.planned) curTitle = "今日任务还没定";
  else if (cur) {
    curTitle = cur.title;
    curSub = `${fmt(cur.start!)} – ${fmt(cur.end!)}，还剩 ${dur(cur.end! - nowMin)}`;
  } else if (seg === "lunch") {
    curTitle = "午休";
    curSub = "14:00 下午上班";
  } else if (seg === "off" || seg === "pre") {
    curTitle = seg === "off" ? "已下班" : "还没开始";
    curSub = countdown;
  } else {
    curTitle = "这个时段没有安排";
    curSub = countdown;
  }

  usePanel(
    {
      chips: [
        {
          label: "重排没做完的任务",
          run: async () => {
            await say("重排没做完的任务", "me");
            await say(await t.reflowNow());
          },
        },
        {
          label: "拆分当前任务",
          run: () => {
            const target = cur ?? t.scheduled.find((x) => !x.done);
            if (!target) return say("现在没有要拆的任务。");
            ask(`帮我拆一下「${target.title}」`, `把这个项目任务拆成 3 到 5 个能直接动手的小步骤，每步一行，带大致分钟数：${target.title}（共 ${target.minutes} 分钟）`);
          },
        },
        { label: "重新定今日任务", run: () => t.replan() },
      ],
    },
    [t.tasks, t.planned, cur?.id],
  );

  const punchIn = settings["punch_in:" + today];
  const punchOut = settings["punch_out:" + today];
  const stamp = () => pad(now.getHours()) + ":" + pad(now.getMinutes());

  const obSoon = ONBOARDING_ITEMS.filter((o) => !obState[o.id]).slice(0, 3);

  const submitQuick = async () => {
    const v = quick.trim();
    if (!v) return;
    setQuick("");
    openClaude();
    await say(v, "me");
    await say(await t.addText(v));
  };

  return (
    <div className="cols">
      <section className="col-wide" aria-label="时间流">
        <div className="sec-head">
          <h2>时间流</h2>
          <span className="countdown">{countdown}</span>
        </div>
        {t.planned && (
          <form
            className="quick"
            onSubmit={(e) => {
              e.preventDefault();
              submitQuick();
            }}
          >
            <input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="加一项任务，如 15:00-16:00 需求评审，或 整理字段说明 45分钟" aria-label="加一项任务" />
            <button type="submit" className="btn solid">
              加入
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={async () => {
                openClaude();
                await say("把没做完的往后顺延", "me");
                await say(await t.reflowNow());
              }}
            >
              顺延重排
            </button>
          </form>
        )}
        {t.planned && late.length > 0 && (
          <div className="late-bar">
            <span className="grow">※ {late.map((x) => "「" + x.title + "」").join("")}已过时间还没完成</span>
            <button
              type="button"
              className="text-btn red"
              onClick={async () => {
                await say(await t.reflowNow());
              }}
            >
              顺延到后面 →
            </button>
          </div>
        )}
        {!t.planned && t.loaded && <div className="muted small">在右边和 Claude 定好今天做什么，就会排进这里。</div>}
        <div className="timeline">
          <div className="seg" style={{ top: px(AM_START), height: px(LUNCH_START) - px(AM_START) }} />
          <div className="seg" style={{ top: px(PM_START), height: px(DAY_END) - px(PM_START) }} />
          <div className="rail" style={{ top: px(AM_START), height: px(LUNCH_START) - px(AM_START) }} />
          <div className="rail" style={{ top: px(PM_START), height: px(DAY_END) - px(PM_START) }} />
          <div className="past" style={{ height: Math.max(0, px(nowMin) - 10) }} />
          {Array.from({ length: 9 }, (_, i) => (
            <div key={"h" + i} className="half" style={{ top: px((9 + i) * 60 + 30) }} />
          ))}
          {Array.from({ length: 10 }, (_, i) => (
            <div key={"t" + i} className="hour" style={{ top: px((9 + i) * 60) }}>
              <span className="hour-label">{pad(9 + i)}:00</span>
              <span className="hour-line" />
            </div>
          ))}
          <div className="lunch" style={{ top: px(LUNCH_START), height: px(PM_START) - px(LUNCH_START) }}>
            <span className="lunch-tag">
              <span className="lunch-name">午休</span>
              <span className="mono tiny">11:40 – 14:00</span>
            </span>
          </div>
          {t.scheduled.map((x) => {
            const st = status(x);
            const label = st === "now" ? "进行中" : st === "late" ? "已过时" : st === "todo" && x.pinned ? "固定" : "";
            return (
              <div key={x.id} className={"block " + st} style={{ top: px(x.start!) + 1, height: px(x.end!) - px(x.start!) - 2 }}>
                <Check on={x.done} invert={st === "now"} onClick={() => t.toggle(x.id)} label={"切换完成：" + x.title} />
                <span className="block-title tline">{x.title}</span>
                <span className="block-range">
                  {fmt(x.start!)}–{fmt(x.end!)}
                </span>
                {label && <span className="block-status">{label}</span>}
                <span className="block-tools">
                  <button type="button" onClick={() => t.togglePin(x.id)}>
                    {x.pinned ? "取消固定" : "固定"}
                  </button>
                  <button type="button" onClick={() => t.remove(x.id)}>
                    删除
                  </button>
                </span>
              </div>
            );
          })}
          {nowMin >= AM_START && nowMin <= DAY_END && (
            <div className="now-line" style={{ top: px(nowMin) }}>
              <span className="now-clock">{fmt(nowMin)}</span>
              <span className="now-rule" />
            </div>
          )}
        </div>
        {t.overflow.length > 0 && <div className="small red">※ 今天放不下：{t.overflow.map((x) => x.title).join("、")}，明天早上会出现在待选里。</div>}
      </section>

      <aside className="col-side">
        <div className="side-block">
          <div className="label red">此刻</div>
          <div className="now-title">{curTitle}</div>
          {curSub && <div className="small ink2">{curSub}</div>}
          {cur && (
            <div className="row-btns">
              <button type="button" className="btn solid sm" onClick={() => t.toggle(cur.id)}>
                完成
              </button>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => ask(`帮我拆一下「${cur.title}」`, `把这个项目任务拆成 3 到 5 个能直接动手的小步骤，每步一行，带大致分钟数：${cur.title}（共 ${cur.minutes} 分钟）`)}
              >
                让 Claude 拆一下
              </button>
            </div>
          )}
        </div>

        <div className="side-block">
          <div className="label">今日</div>
          <div className="kv">
            <span>工时</span>
            <span className="mono">{workPct}%</span>
          </div>
          <div className="bar">
            <div style={{ width: workPct + "%" }} />
          </div>
          <div className="kv">
            <span>任务</span>
            <span className="mono">
              {doneCount} / {workTasks.length}
            </span>
          </div>
        </div>

        <div className="side-block">
          <div className="label">打卡</div>
          <div className="kv">
            <span>上班</span>
            {punchIn ? (
              <span className="mono">{punchIn}</span>
            ) : (
              <button type="button" className="text-btn mono" onClick={() => setSetting("punch_in:" + today, stamp())}>
                记一下 →
              </button>
            )}
          </div>
          <div className="kv">
            <span>下班</span>
            {punchOut ? (
              <span className="mono">{punchOut}</span>
            ) : nowMin >= DAY_END - 10 ? (
              <button type="button" className="text-btn mono red" onClick={() => setSetting("punch_out:" + today, stamp())}>
                记一下 →
              </button>
            ) : (
              <span className="mono ink2">18:00 后</span>
            )}
          </div>
        </div>

        <div className="side-block">
          <div className="kv">
            <span className="label">入职待办</span>
            <button type="button" className="text-btn" onClick={() => go("onboard")}>
              全部 →
            </button>
          </div>
          {obSoon.length === 0 && <div className="small ink2">都办完了</div>}
          {obSoon.map((o) => {
            const days = daysBetween(now, parseDay(o.due));
            return (
              <div key={o.id} className="kv small">
                <span className="grow min0">{o.title}</span>
                <span className={"mono tiny" + (days <= 7 ? " red" : " ink2")}>
                  {days < 0 ? `逾期 ${-days} 天` : days === 0 ? "今天截止" : days <= 7 ? `剩 ${days} 天` : md(parseDay(o.due))}
                </span>
              </div>
            );
          })}
        </div>

        <div className="side-last">
          <button type="button" className="btn ghost" onClick={() => go("log")}>
            写今日日志
          </button>
        </div>
      </aside>
    </div>
  );
}
