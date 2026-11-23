import { useApp, usePanel } from "../ctx";
import Check from "../components/Check";
import { api } from "../lib/api";
import { JOIN_DATE, ONBOARDING, ONBOARDING_ITEMS } from "../lib/onboarding";
import { daysBetween, md, parseDay } from "../lib/time";

export default function Onboarding({ state }: { state: Record<string, boolean> }) {
  const { now, ask, bumpOb } = useApp();
  const total = ONBOARDING_ITEMS.length;
  const done = ONBOARDING_ITEMS.filter((o) => state[o.id]).length;

  const listText = () =>
    ONBOARDING_ITEMS.map((o) => `- [${state[o.id] ? "x" : " "}] ${o.title}（${o.hint}，截止 ${o.due}）`).join("\n");

  usePanel(
    {
      chips: [
        {
          label: "这周先做哪些",
          run: () =>
            ask(
              "入职清单这周先做哪些",
              `我的入职清单：\n${listText()}\n\n按截止时间和重要程度，告诉我这周先做哪几项，每项一句话说怎么办。入职事项不进工作时间流，在入职清单里跟踪就行。`,
            ),
        },
      ],
      context: () => "我的入职清单：\n" + listText(),
    },
    [state],
  );

  const toggle = async (id: string) => {
    await api.onboardingSet(id, !state[id]);
    bumpOb();
  };

  const [jy, jm, jd] = JOIN_DATE.split("-");

  return (
    <div className="stack">
      <section className="ob-top">
        <div className="ob-count">
          <div className="ob-num">
            {done}
            <span> / {total}</span>
          </div>
          <div className="bar">
            <div style={{ width: Math.round((done / total) * 100) + "%" }} />
          </div>
          <div className="mono small ink2">
            入职 {jy}/{+jm}/{+jd}
          </div>
        </div>
        <p className="ob-warn">※ 离职证明、学信网学历证明、体检报告、新员工培训及在线测试、信息安全培训考试，任一项未完成或考试低于 85 分，视为试用期考核不合格。</p>
      </section>

      <section className="ob-grid">
        {ONBOARDING.map((g) => (
          <div key={g.title} className="ob-group">
            <div className="ob-group-head">
              <h2>{g.title}</h2>
              <span className="mono tiny ink2">{g.sub}</span>
            </div>
            {g.items.map((o) => {
              const isDone = !!state[o.id];
              const days = daysBetween(now, parseDay(o.due));
              let label = md(parseDay(o.due));
              let red = false;
              if (isDone) label = "已完成";
              else if (days < 0) {
                label = `逾期 ${-days} 天`;
                red = true;
              } else if (days === 0) {
                label = "今天截止";
                red = true;
              } else if (days <= 7) {
                label = `剩 ${days} 天`;
                red = true;
              }
              return (
                <div key={o.id} className="ob-item">
                  <Check on={isDone} top onClick={() => toggle(o.id)} label={"切换完成：" + o.title} />
                  <div className="grow min0">
                    <div className={isDone ? "struck" : ""}>{o.title}</div>
                    <div className="tiny ink2">{o.hint}</div>
                  </div>
                  <span className={"mono tiny" + (red ? " red" : " ink2")}>{label}</span>
                </div>
              );
            })}
          </div>
        ))}
      </section>
    </div>
  );
}
