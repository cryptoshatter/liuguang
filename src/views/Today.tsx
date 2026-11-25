import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fl, useApp } from "../ctx";
import { pendingOb } from "../lib/onboarding";
import { MIN_LEN, fitSpan, settle, snap } from "../lib/plan";
import { AM_START, DAY_END, LUNCH_START, PM_START, daysBetween, dur, fmt, md, minutesOf, pad, parseDay } from "../lib/time";

const LUNCH_PX = 30;
const HOLD_MS = 280;

type Drag = { id: string; mode: "move" | "top" | "bottom"; grab: number; y: number; s: number; e: number; s0: number; e0: number };

export default function Today() {
  const { now, today, todayApi: t, go, ask, say, settings, setSetting, openClaude, obItems, obState, flash } = useApp();
  const [quick, setQuick] = useState("");
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const nowMin = minutesOf(now);
  const tlRef = useRef<HTMLDivElement>(null);
  const [tlH, setTlH] = useState(620);
  useLayoutEffect(() => {
    const el = tlRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTlH(el.clientHeight));
    ro.observe(el);
    setTlH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const lunchPx = PM_START > LUNCH_START ? LUNCH_PX : 0;
  const k = Math.max(0.6, (tlH - 24 - lunchPx) / (LUNCH_START - AM_START + DAY_END - PM_START));
  const px = (v: number) => {
    const m = Math.max(AM_START, Math.min(DAY_END, v));
    if (m <= LUNCH_START) return 10 + (m - AM_START) * k;
    const am = (LUNCH_START - AM_START) * k;
    if (m < PM_START) return 10 + am + ((m - LUNCH_START) / (PM_START - LUNCH_START)) * lunchPx;
    return 10 + am + lunchPx + (m - PM_START) * k;
  };
  const toMin = (y: number) => {
    const am = (LUNCH_START - AM_START) * k;
    const v = y - 10;
    if (v <= am) return AM_START + v / k;
    if (v < am + lunchPx) return LUNCH_START + ((v - am) / lunchPx) * (PM_START - LUNCH_START);
    return PM_START + (v - am - lunchPx) / k;
  };
  const inLunch = (m: number) => m > LUNCH_START && m < PM_START;

  const [drag, setDrag] = useState<Drag | null>(null);
  const [pressing, setPressing] = useState<string | null>(null);
  const [landing, setLanding] = useState<string | null>(null);
  const press = useRef<{ id: string; x: number; y: number; timer: number } | null>(null);
  const live = useRef({ t, drag, toMin, px });
  live.current = { t, drag, toMin, px };
  const tlY = (clientY: number) => clientY - (tlRef.current?.getBoundingClientRect().top ?? 0);

  const step = (d: Drag, clientY: number): Drag => {
    const y = tlY(clientY);
    const { toMin: tm, t: api } = live.current;
    if (d.mode === "move") {
      const [s, e] = fitSpan(snap(tm(y - d.grab)), d.e0 - d.s0);
      return { ...d, y, s, e };
    }
    const am = d.s0 < LUNCH_START;
    if (d.mode === "bottom") {
      const e = Math.max(d.s0 + MIN_LEN, Math.min(am ? LUNCH_START : DAY_END, snap(tm(y))));
      return { ...d, y, e };
    }
    const prev = api.scheduled.filter((x) => x.id !== d.id && x.end! <= d.s0).reduce((m, x) => Math.max(m, x.end!), am ? AM_START : PM_START);
    const s = Math.min(d.e0 - MIN_LEN, Math.max(prev, snap(tm(y))));
    return { ...d, y, s };
  };

  const finish = async (d: Drag) => {
    setDrag(null);
    document.body.classList.remove("tl-drag", "tl-move", "tl-resize");
    if (d.s === d.s0 && d.e === d.e0) return;
    const ok = await live.current.t.move(d.id, d.s, d.e);
    if (ok) {
      setLanding(d.id);
      window.setTimeout(() => setLanding((v) => (v === d.id ? null : v)), 360);
    }
  };

  const begin = (id: string, mode: Drag["mode"], clientY: number) => {
    const x = live.current.t.scheduled.find((v) => v.id === id);
    if (!x) return;
    const y = tlY(clientY);
    document.body.classList.add("tl-drag", mode === "move" ? "tl-move" : "tl-resize");
    setDrag({ id, mode, grab: y - live.current.px(x.start!), y, s: x.start!, e: x.end!, s0: x.start!, e0: x.end! });
  };

  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    setPressing(null);
  };

  const onBlockDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const edge = (e.target as HTMLElement).dataset.edge as "top" | "bottom" | undefined;
    e.preventDefault();
    if (edge) {
      begin(id, edge, e.clientY);
      return;
    }
    cancelPress();
    const cy = e.clientY;
    setPressing(id);
    press.current = {
      id,
      x: e.clientX,
      y: cy,
      timer: window.setTimeout(() => {
        press.current = null;
        setPressing(null);
        begin(id, "move", cy);
      }, HOLD_MS),
    };
  };

  useEffect(() => {
    const mv = (e: PointerEvent) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) cancelPress();
      const d = live.current.drag;
      if (d) setDrag(step(d, e.clientY));
    };
    const up = () => {
      cancelPress();
      const d = live.current.drag;
      if (!d) return;
      const pv = settle(live.current.t.tasks, d.id, d.s, d.e);
      if (pv.ok) finish(d);
      else {
        setDrag(null);
        document.body.classList.remove("tl-drag", "tl-move", "tl-resize");
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && live.current.drag) {
        setDrag(null);
        document.body.classList.remove("tl-drag", "tl-move", "tl-resize");
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && tag !== "INPUT" && tag !== "TEXTAREA" && !(e.target as HTMLElement)?.isContentEditable) {
        e.preventDefault();
        live.current.t.undoMove();
      }
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key);
      document.body.classList.remove("tl-drag", "tl-move", "tl-resize");
    };
  }, []);

  const preview = drag ? settle(t.tasks, drag.id, drag.s, drag.e) : null;
  const shown = preview ? preview.tasks.filter((x) => x.start != null) : t.scheduled;
  const bad = !!preview && !preview.ok;
  const minH = Math.ceil(0.6 * (LUNCH_START - AM_START + DAY_END - PM_START) + lunchPx + 24);
  const MARKS: [number, string][] = [
    [AM_START, "上班"],
    [LUNCH_START, "午饭"],
    [PM_START, "下午上班"],
    [DAY_END, "下班"],
  ];
  const h0 = Math.ceil(AM_START / 60);
  const h1 = Math.floor(DAY_END / 60);
  const removeTask = (id: string) => {
    setLeaving((l) => new Set(l).add(id));
    window.setTimeout(() => {
      t.remove(id);
      setLeaving((l) => {
        const n = new Set(l);
        n.delete(id);
        return n;
      });
    }, 220);
  };

  const seg = nowMin < AM_START ? "pre" : nowMin < LUNCH_START ? "am" : nowMin < PM_START ? "lunch" : nowMin < DAY_END ? "pm" : "off";
  const next = MARKS.find((m) => m[0] > nowMin);
  const countdown = next ? `距${next[1]} ${dur(next[0] - nowMin)}` : "已下班";
  const worked = Math.min(Math.max(nowMin, AM_START), LUNCH_START) - AM_START + (Math.min(Math.max(nowMin, PM_START), DAY_END) - PM_START);
  const workPct = Math.round((worked / (LUNCH_START - AM_START + DAY_END - PM_START)) * 100);

  const status = (x: (typeof t.scheduled)[number]) =>
    x.done ? "done" : nowMin >= x.start! && nowMin < x.end! ? "now" : "todo";
  const cur = t.scheduled.find((x) => status(x) === "now");
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
    curSub = fmt(PM_START) + " 下午上班";
  } else if (seg === "off" || seg === "pre") {
    curTitle = seg === "off" ? "已下班" : "还没开始";
    curSub = countdown;
  } else {
    curTitle = "这个时段没有安排";
    curSub = countdown;
  }

  const punchIn = settings["punch_in:" + today];
  const punchOut = settings["punch_out:" + today];
  const stamp = () => pad(now.getHours()) + ":" + pad(now.getMinutes());

  const obSoon = pendingOb(obItems, obState).slice(0, 3);

  const submitQuick = async () => {
    const v = quick.trim();
    if (!v) return;
    setQuick("");
    openClaude();
    await say(v, "me");
    await say(await t.addText(v));
  };

  return (
    <div className="cols fill">
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
            <input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="加任务，如 15:00 需求评审 1小时" aria-label="加一项任务" />
            <button type="submit" className="btn solid">
              加入
            </button>
          </form>
        )}
        {!t.planned && t.loaded && <div className="muted small">在右边和 Claude 定好今天做什么，就会排进这里。</div>}
        <div className={"timeline" + (drag ? " dragging" : "")} ref={tlRef} style={{ minHeight: minH }}>
          <div className="seg" style={{ top: px(AM_START), height: px(LUNCH_START) - px(AM_START) }} />
          <div className="seg" style={{ top: px(PM_START), height: px(DAY_END) - px(PM_START) }} />
          <div className="rail" style={{ top: px(AM_START), height: px(LUNCH_START) - px(AM_START) }} />
          <div className="rail" style={{ top: px(PM_START), height: px(DAY_END) - px(PM_START) }} />
          <div className="past" style={{ height: Math.max(0, px(nowMin) - 10) }} />
          {Array.from({ length: h1 - h0 }, (_, i) => (h0 + i) * 60 + 30)
            .filter((m) => !inLunch(m) && m < DAY_END && m > AM_START)
            .map((m) => (
              <div key={"h" + m} className="half" style={{ top: px(m) }} />
            ))}
          {Array.from({ length: h1 - h0 + 1 }, (_, i) => h0 + i)
            .filter((h) => !inLunch(h * 60))
            .map((h) => (
              <div key={"t" + h} className="hour" style={{ top: px(h * 60) }}>
                <span className="hour-label">{pad(h)}:00</span>
                <span className="hour-line" />
              </div>
            ))}
          <div className="lunch" style={{ top: px(LUNCH_START), height: px(PM_START) - px(LUNCH_START) }}>
            <span className="lunch-tag">
              <span className="lunch-name">午休</span>
              <span className="mono tiny">
                {fmt(LUNCH_START)} – {fmt(PM_START)}
              </span>
            </span>
          </div>
          {drag && !bad && <div className="drop-mark" style={{ top: px(drag.s), height: px(drag.e) - px(drag.s) }} />}
          {drag?.mode === "move" && <div className={"block-ghost" + (bad ? " bad" : "")} style={{ top: px(drag.s) + 1, height: px(drag.e) - px(drag.s) - 2 }} />}
          {shown.map((x) => {
            const st = status(x);
            const label = st === "now" ? "进行中" : "";
            const mine = drag?.id === x.id;
            const lifted = mine && drag!.mode === "move";
            const h = px(x.end!) - px(x.start!) - 2;
            const short = h < 50;
            const lo = px(AM_START);
            const hi = px(DAY_END) - h - 2;
            const top = lifted ? Math.max(lo, Math.min(hi, drag!.y - drag!.grab)) : px(x.start!) + 1;
            const cls = [
              "block",
              st,
              short && "short",
              !x.done && "movable",
              pressing === x.id && "pressing",
              lifted && "lifted",
              mine && !lifted && "resizing",
              mine && bad && "bad",
              landing === x.id && "landing",
              leaving.has(x.id) && "leaving",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div key={x.id} className={cls + fl(flash, x.id)} style={{ top, height: h }} onPointerDown={x.done ? undefined : (e) => onBlockDown(e, x.id)}>
                {st === "now" && <div className="block-ink" style={{ height: ((nowMin - x.start!) / (x.end! - x.start!)) * 100 + "%" }} />}
                {!x.done && <span className="block-edge top" data-edge="top" />}
                {!x.done && <span className="block-edge bottom" data-edge="bottom" />}
                <div className="block-main">
                  <span className="block-title tline">{x.title}</span>
                  <span className="block-range">
                    {fmt(x.start!)} – {fmt(x.end!)} · {dur(x.end! - x.start!)}
                  </span>
                </div>
                {label && <span className={"block-status " + st}>{label}</span>}
                <span className="block-tools">
                  {x.done && (
                    <button type="button" onClick={async () => say(await t.notDone(x.id))}>
                      没做完
                    </button>
                  )}
                  <button type="button" onClick={() => removeTask(x.id)}>
                    删除
                  </button>
                </span>
              </div>
            );
          })}
          {nowMin >= AM_START && nowMin <= DAY_END && (
            <div className="now-line" style={{ top: px(nowMin) }}>
              <span className="now-clock">{fmt(nowMin)}</span>
              <span className="now-rule">
                <i />
              </span>
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
              <button type="button" className="punch-val" onClick={() => setSetting("punch_in:" + today, "")} aria-label="清掉上班打卡">
                {punchIn}
              </button>
            ) : (
              <button type="button" className="text-btn mono" onClick={() => setSetting("punch_in:" + today, stamp())}>
                记一下 →
              </button>
            )}
          </div>
          <div className="kv">
            <span>下班</span>
            {punchOut ? (
              <button type="button" className="punch-val" onClick={() => setSetting("punch_out:" + today, "")} aria-label="清掉下班打卡">
                {punchOut}
              </button>
            ) : nowMin >= DAY_END - 10 ? (
              <button type="button" className="text-btn mono red" onClick={() => setSetting("punch_out:" + today, stamp())}>
                记一下 →
              </button>
            ) : (
              <span className="mono ink2">{fmt(DAY_END)} 后</span>
            )}
          </div>
        </div>

        {obItems.length > 0 && (
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
        )}

        <div className="side-last">
          <button type="button" className="btn ghost" onClick={() => go("log")}>
            写今日日志
          </button>
        </div>
      </aside>
    </div>
  );
}
