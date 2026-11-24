import { useState } from "react";
import { fl, useApp } from "../ctx";
import Check from "../components/Check";
import { api } from "../lib/api";
import { groupOb } from "../lib/onboarding";
import { daysBetween, md, parseDay, uid } from "../lib/time";

export default function Onboarding() {
  const { now, obItems, obState, setSetting, bumpData, flash, profile } = useApp();
  const [draft, setDraft] = useState({ title: "", due: "", group: "" });
  const total = obItems.length;
  const done = obItems.filter((o) => obState[o.id]).length;

  const toggle = async (id: string) => {
    await api.onboardingSet(id, !obState[id]);
    bumpData();
  };

  const add = async () => {
    const title = draft.title.trim();
    if (!title) return;
    await setSetting("ob_items", JSON.stringify([...obItems, { id: uid(), title, hint: "", due: draft.due, group: draft.group.trim() }]));
    setDraft({ title: "", due: "", group: draft.group });
  };

  const remove = (id: string) => setSetting("ob_items", JSON.stringify(obItems.filter((o) => o.id !== id)));

  return (
    <div className="stack">
      {total > 0 && (
        <section className="ob-top">
          <div className="ob-count">
            <div className="ob-num">
              {done}
              <span> / {total}</span>
            </div>
            <div className="bar">
              <div style={{ width: Math.round((done / total) * 100) + "%" }} />
            </div>
            {profile.joinDate && <div className="mono small ink2">入职 {profile.joinDate.replace(/-0?/g, "/")}</div>}
          </div>
        </section>
      )}

      <section className="ob-grid">
        {groupOb(obItems).map((g) => (
          <div key={g.title} className="ob-group">
            <div className="ob-group-head">
              <h2>{g.title}</h2>
              <span className="mono tiny ink2">{g.sub}</span>
            </div>
            {g.items.map((o) => {
              const isDone = !!obState[o.id];
              const days = o.due ? daysBetween(now, parseDay(o.due)) : null;
              let label = o.due ? md(parseDay(o.due)) : "";
              let red = false;
              if (isDone) label = "已完成";
              else if (days != null && days < 0) {
                label = `逾期 ${-days} 天`;
                red = true;
              } else if (days === 0) {
                label = "今天截止";
                red = true;
              } else if (days != null && days <= 7) {
                label = `剩 ${days} 天`;
                red = true;
              }
              return (
                <div key={o.id} className={"ob-item" + fl(flash, o.id)}>
                  <Check on={isDone} top onClick={() => toggle(o.id)} label={"切换完成：" + o.title} />
                  <div className="grow min0">
                    <div className={"strike" + (isDone ? " struck" : "")}>{o.title}</div>
                    {o.hint && <div className="tiny ink2">{o.hint}</div>}
                  </div>
                  <span className={"mono tiny nowrap" + (red ? " red" : " ink2")}>{label}</span>
                  <button type="button" className="x" onClick={() => remove(o.id)} aria-label={"删除：" + o.title}>
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </section>

      <form
        className="inline-form ob-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="加一项" aria-label="事项" />
        <input value={draft.group} onChange={(e) => setDraft({ ...draft, group: e.target.value })} placeholder="分组" aria-label="分组" className="ob-add-group" />
        <input type="date" value={draft.due} onChange={(e) => setDraft({ ...draft, due: e.target.value })} aria-label="截止日期" />
        <button type="submit" className="text-btn">
          加上
        </button>
      </form>
    </div>
  );
}
