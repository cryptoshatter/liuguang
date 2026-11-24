import { useState } from "react";
import { fl, useApp } from "../ctx";
import Check from "../components/Check";
import { api } from "../lib/api";
import { groupOb } from "../lib/onboarding";
import { daysBetween, md, parseDay, uid } from "../lib/time";

export default function Onboarding() {
  const { now, obItems, obState, setSetting, bumpData, flash, profile } = useApp();
  const [draft, setDraft] = useState({ title: "", due: "", group: "" });
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const flip = (k: string) =>
    setOpened((o) => {
      const n = new Set(o);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
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

  const later = (o: { due: string }) => !!o.due && daysBetween(now, parseDay(o.due)) > 30;
  const groups = groupOb(obItems)
    .map((g) => {
      const todo = g.items.filter((o) => !obState[o.id]);
      return { ...g, done: g.items.filter((o) => obState[o.id]), soon: todo.filter((o) => !later(o)), later: todo.filter(later) };
    })
    .sort((a, b) => Number(!a.soon.length && !a.later.length) - Number(!b.soon.length && !b.later.length) || Number(!a.soon.length) - Number(!b.soon.length));

  const row = (o: (typeof obItems)[number]) => {
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
  };

  const fold = (key: string, n: number, text: string, items: typeof obItems) =>
    n > 0 && (
      <>
        <button type="button" className="ob-fold" onClick={() => flip(key)} aria-expanded={opened.has(key)}>
          {text} {n} 项<span>{opened.has(key) ? "收起" : "展开"}</span>
        </button>
        {opened.has(key) && items.map(row)}
      </>
    );

  return (
    <div className="stack">
      {total > 0 && (
        <section className="ob-top">
          <div className="ob-num">
            {done}
            <span> / {total}</span>
          </div>
          <div className="bar grow">
            <div style={{ width: Math.round((done / total) * 100) + "%" }} />
          </div>
          {profile.joinDate && <div className="mono small ink2 nowrap">入职 {profile.joinDate.replace(/-0?/g, "/")}</div>}
        </section>
      )}

      <section className="ob-grid">
        {groups.map((g) => (
          <div key={g.title} className="ob-group">
            <div className="ob-group-head">
              <h2>{g.title}</h2>
              <span className="mono tiny ink2">{g.soon.length || g.later.length ? g.sub : "已全部完成"}</span>
            </div>
            {g.soon.map(row)}
            {fold(g.title + ":later", g.later.length, "以后再办", g.later)}
            {fold(g.title + ":done", g.done.length, "已完成", g.done)}
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
