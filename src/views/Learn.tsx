import { useCallback, useEffect, useState } from "react";
import { fl, useApp, useFocus } from "../ctx";
import Check from "../components/Check";
import { api, type Goal } from "../lib/api";
import { splitJson } from "../lib/claude";
import { pad, uid } from "../lib/time";

export default function Learn() {
  const { settings, setSetting, ask, say, stages: STAGES, dataVersion, flash } = useApp();
  const current = Math.max(0, Math.min(STAGES.length - 1, Number(settings.learn_stage ?? 0) || 0));
  const [dir, setDir] = useState("");
  const [sel, setSel] = useState(current);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [draft, setDraft] = useState("");
  const [planOpen, setPlanOpen] = useState(false);
  const [plan, setPlan] = useState(settings.learn_plan ?? "");

  const load = useCallback(async () => {
    setGoals(await api.goalsList());
  }, []);

  useEffect(() => {
    load();
  }, [load, dataVersion]);

  const makeStages = async () => {
    const v = dir.trim();
    if (!v) return;
    const raw = await ask(
      `学习方向：${v}`,
      `我想学：${v}。按由浅到深给我排一条学习路线，6 到 9 个阶段。只输出 json 代码块：{"stages":[{"name":"阶段名","weeks":2,"why":"一句话说为什么学","topics":["要点"]}]}`,
      { show: () => "路线已生成。" },
    );
    const st = (splitJson(raw ?? "").json as { stages?: unknown } | null)?.stages;
    if (!Array.isArray(st) || !st.length) return;
    await setSetting("learn_stages", JSON.stringify(st));
    await setSetting("learn_stage", "0");
    setSel(0);
  };

  const fStage = STAGES[Math.min(sel, Math.max(STAGES.length - 1, 0))];
  useFocus(
    () =>
      !fStage ? "学习路线页，还没定路线" : `学习路线页，选中第 ${sel} 阶段「${fStage.name}」：${fStage.topics.join("、")}。目标：${goals.filter((g) => g.stage === sel).map((g) => (g.done ? "[x] " : "[ ] ") + g.title).join("；") || "无"}`,
    [sel, goals, STAGES],
  );

  if (!STAGES.length)
    return (
      <div className="empty-state">
        <h2>想学什么方向</h2>
        <form
          className="inline-form wide-form"
          onSubmit={(e) => {
            e.preventDefault();
            makeStages();
          }}
        >
          <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="比如：数据开发，从 SQL 开始" aria-label="学习方向" />
          <button type="submit" className="btn solid">
            生成路线
          </button>
        </form>
      </div>
    );

  const stage = STAGES[Math.min(sel, STAGES.length - 1)];
  const mine = goals.filter((g) => g.stage === sel);
  const doneN = mine.filter((g) => g.done).length;
  const totalWeeks = STAGES.reduce((a, s) => a + s.weeks, 0);

  const statusOf = (i: number) => (i < current ? "已学完" : i === current ? "进行中" : "未开始");

  const quiz = () =>
    ask(
      `出 5 道${STAGES[current].name}练习题`,
      `我在学「${STAGES[current].name}」，这阶段的内容：${STAGES[current].topics.join("、")}。本周目标：${goals
        .filter((g) => g.stage === current)
        .map((g) => g.title)
        .join("、")}。用贴近实际工作的场景出 5 道由浅到深的练习题，只出题不给答案。`,
    );

  const goalsFromPlan = async () => {
    if (!plan.trim()) return;
    await setSetting("learn_plan", plan);
    const raw = await ask(
      "按学习计划拆出本周目标",
      `这是我的学习计划：\n${plan}\n\n我现在在第 ${current + 1} 阶段「${STAGES[current].name}」。从计划里拆出本周要完成的 3 到 6 个具体目标，每个目标一行，以「- 」开头，不要别的内容。`,
      { show: (r) => "已加入本周目标：\n" + r.trim() },
    );
    if (!raw) return;
    const lines = raw
      .split("\n")
      .map((l) => l.replace(/^\s*[-*•\d.、)]+\s*/, "").trim())
      .filter((l) => l && l.length < 60);
    for (const l of lines) await api.goalAdd(uid(), current, l);
    setPlanOpen(false);
    load();
  };

  const addGoal = async () => {
    const v = draft.trim();
    if (!v) return;
    await api.goalAdd(uid(), sel, v);
    setDraft("");
    load();
  };

  const finishStage = async () => {
    if (current >= STAGES.length - 1) return;
    await setSetting("learn_stage", String(current + 1));
    setSel(current + 1);
    await say(`「${STAGES[current].name}」学完了，进入「${STAGES[current + 1].name}」。`);
  };

  return (
    <div className="stack">
      <div className="learn-bar small ink2">
        <span>{settings.learn_plan ? "已导入学习计划" : ""}</span>
        <button type="button" className="text-btn" onClick={() => setPlanOpen((o) => !o)}>
          {settings.learn_plan ? "查看学习计划" : "导入学习计划"} →
        </button>
      </div>
      {planOpen && (
        <div className="plan-box">
          <textarea className="ruled" rows={6} value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="把学习计划粘贴到这里" aria-label="学习计划" />
          <div className="row-btns">
            <button type="button" className="btn solid" onClick={() => setSetting("learn_plan", plan).then(() => setPlanOpen(false))}>
              保存
            </button>
            <button type="button" className="btn ghost" onClick={goalsFromPlan} disabled={!plan.trim()}>
              让 Agent 拆成本周目标
            </button>
          </div>
        </div>
      )}
      <div className="cols">
        <section className="col-list" aria-label="路线">
          <div className="rule-top">
            {STAGES.map((s, i) => (
              <button key={s.name} type="button" className={"stage-row" + (sel === i ? " on" : "")} onClick={() => setSel(i)} aria-pressed={sel === i}>
                <span className={"mono tiny stage-no" + (i === current ? " red" : i < current ? "" : " ink2")}>{pad(i + 1)}</span>
                <span className={"grow serif stage-name" + (i < current ? " struck" : "")}>{s.name}</span>
                <span className={"mono tiny" + (i === current ? " red" : " ink2")}>
                  {i === current ? "进行中 · " : i < current ? "已学完 · " : ""}
                  {s.weeks} 周
                </span>
              </button>
            ))}
          </div>
          <div className="mono tiny ink2 pad-y">合计约 {totalWeeks} 周</div>
        </section>

        <section className="col-read">
          <div className="mono small red">
            第 {sel + 1} 阶段 · {statusOf(sel)} · 约 {stage.weeks} 周
          </div>
          <h2 className="stage-title">{stage.name}</h2>
          <p className="m0">{stage.why}</p>
          <div className="small ink2 lh">{stage.topics.join(" / ")}</div>

          <div className="goals">
            <div className="ob-group-head">
              <h3>{sel === current ? "本周目标" : "目标"}</h3>
              <span className="mono small">
                {doneN} / {mine.length}
              </span>
            </div>
            {mine.map((g) => (
              <div key={g.id} className={"goal-row" + fl(flash, g.id)}>
                <Check
                  on={g.done}
                  onClick={async () => {
                    await api.goalSetDone(g.id, !g.done);
                    load();
                  }}
                  label={"切换完成：" + g.title}
                />
                <span className={"grow strike" + (g.done ? " struck" : "")}>{g.title}</span>
                <button
                  type="button"
                  className="x"
                  onClick={async () => {
                    await api.goalDelete(g.id);
                    load();
                  }}
                  aria-label={"删除：" + g.title}
                >
                  ×
                </button>
              </div>
            ))}
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                addGoal();
              }}
            >
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="加一个目标" aria-label="加一个目标" />
              <button type="submit" className="text-btn">
                加上
              </button>
            </form>
            <div className="row-btns pad-top">
              {sel === current && (
                <button type="button" className="btn ghost" onClick={quiz}>
                  让 Agent 出 5 道练习题
                </button>
              )}
              {sel === current && current < STAGES.length - 1 && (
                <button type="button" className="btn ghost" onClick={finishStage}>
                  这一阶段学完了
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
