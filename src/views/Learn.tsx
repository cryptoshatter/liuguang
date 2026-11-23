import { useCallback, useEffect, useState } from "react";
import { useApp, usePanel } from "../ctx";
import Check from "../components/Check";
import { api, type Goal } from "../lib/api";
import { SEED_GOALS, STAGES } from "../lib/stages";
import { pad, uid } from "../lib/time";

export default function Learn() {
  const { settings, setSetting, ask, say } = useApp();
  const current = Math.min(STAGES.length - 1, Number(settings.learn_stage ?? 0) || 0);
  const [sel, setSel] = useState(current);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [draft, setDraft] = useState("");
  const [planOpen, setPlanOpen] = useState(false);
  const [plan, setPlan] = useState(settings.learn_plan ?? "");

  const load = useCallback(async () => {
    let gs = await api.goalsList();
    if (!gs.length && settings.goals_seeded !== "1") {
      for (const g of SEED_GOALS) await api.goalAdd(uid(), 0, g);
      await setSetting("goals_seeded", "1");
      gs = await api.goalsList();
    }
    setGoals(gs);
  }, [settings.goals_seeded, setSetting]);

  useEffect(() => {
    load();
  }, [load]);

  const stage = STAGES[sel];
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
        .join("、")}。用银行业务场景（客户、账户、交易、网点）出 5 道由浅到深的练习题，只出题不给答案。`,
    );

  const goalsFromPlan = async () => {
    if (!plan.trim()) return;
    await setSetting("learn_plan", plan);
    const raw = await ask(
      "按学习计划拆出本周目标",
      `这是项目经理给我的学习计划：\n${plan}\n\n我现在在第 ${current + 1} 阶段「${STAGES[current].name}」。从计划里拆出本周要完成的 3 到 6 个具体目标，每个目标一行，以「- 」开头，不要别的内容。`,
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

  usePanel(
    {
      chips: [{ label: "出 5 道练习题", run: quiz }],
      context: () => `我的学习路线：${STAGES.map((s, i) => `${i + 1}.${s.name}（${statusOf(i)}）`).join("，")}。当前阶段「${STAGES[current].name}」本周目标：${goals
        .filter((g) => g.stage === current)
        .map((g) => (g.done ? "[x] " : "[ ] ") + g.title)
        .join("；")}`,
    },
    [goals, current],
  );

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
        <span>{settings.learn_plan ? "已导入项目经理的学习计划。" : "项目经理的学习计划还没到，当前为建议路线。"}</span>
        <button type="button" className="text-btn" onClick={() => setPlanOpen((o) => !o)}>
          {settings.learn_plan ? "查看学习计划" : "导入学习计划"} →
        </button>
      </div>
      {planOpen && (
        <div className="plan-box">
          <textarea className="ruled" rows={6} value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="把项目经理发来的学习计划粘贴到这里" aria-label="学习计划" />
          <div className="row-btns">
            <button type="button" className="btn solid" onClick={() => setSetting("learn_plan", plan).then(() => setPlanOpen(false))}>
              保存
            </button>
            <button type="button" className="btn ghost" onClick={goalsFromPlan} disabled={!plan.trim()}>
              让 Claude 拆成本周目标
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
              <div key={g.id} className="goal-row">
                <Check
                  on={g.done}
                  onClick={async () => {
                    await api.goalSetDone(g.id, !g.done);
                    load();
                  }}
                  label={"切换完成：" + g.title}
                />
                <span className={"grow" + (g.done ? " struck" : "")}>{g.title}</span>
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
                  让 Claude 出 5 道练习题
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
