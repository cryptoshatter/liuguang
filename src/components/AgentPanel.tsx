import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import { useApp, type View } from "../ctx";
import { api, errText, type AgentInfo, type ChangeCard, type ChatMsg, type Task } from "../lib/api";
import { ACTIONS_PROTOCOL, splitJson } from "../lib/claude";
import { gatherState, runActions, type Action } from "../lib/assistant";
import { describeChanges } from "../lib/changes";
import { decodeWho, iconFor, shortName, type Who } from "../lib/agents";
import { DAY_END } from "../lib/time";
import Check from "./Check";

const DURS = [20, 30, 45, 60, 90, 120, 180, 240];
const QUICK = /^(帮我)?(下午|上午)?(再)?(加|新增|添加)|^\d{1,2}[:：]\d{2}/;

const VIEW_LABEL: Record<string, string> = { today: "今日时间流", cal: "日历", log: "周报", onboard: "入职清单", mail: "邮箱", learn: "学习路线", settings: "设置" };
const MOD_VIEW: Record<string, View> = { 今日时间流: "today", 时间流: "today", 入职清单: "onboard", 学习路线: "learn", 周报: "log", 日志: "log", 日历: "cal", 邮箱: "mail" };
const TOKEN = /(\d{1,2}[:：]\d{2}(?:\s*[–\-~～至到]\s*\d{1,2}[:：]\d{2})?)|(今日时间流|时间流|入职清单|学习路线|周报|日志|日历|邮箱)/g;

type Props = { chat: ChatMsg[]; focus: MutableRefObject<(() => string) | null>; onClose: () => void };

export function Avatar({ who, size = "md" }: { who: { id: string; name: string; base?: string | null }; size?: "sm" | "md" }) {
  const src = who.id === "app" ? null : iconFor(who.id, who.name, who.base);
  return (
    <span className={"av " + size + (who.id === "app" ? " app" : "")} aria-hidden="true">
      {src ? <img src={src} alt="" draggable={false} /> : <b>{(who.name || "?").slice(0, 1).toUpperCase()}</b>}
    </span>
  );
}

function Rich({ text, go }: { text: string; go: (v: View) => void }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    if (m[1]) out.push(<span key={i} className="tok-time">{m[1].replace(/：/g, ":").replace(/\s*[-~～至到]\s*/, "–")}</span>);
    else
      out.push(
        <button key={i} type="button" className="tok-mod" onClick={() => go(MOD_VIEW[m[2]])}>
          {m[2]}
        </button>,
      );
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

function Cards({ cards, go }: { cards: ChangeCard[]; go: (v: View) => void }) {
  return (
    <>
      {cards.map((c, k) => (
        <div key={k} className="chg">
          <div className="chg-h">
            <span>
              <b>{c.view === "log" && !c.items.some((x) => x.title === "周报") ? "日志" : VIEW_LABEL[c.view] ?? c.view}</b> · {c.items.length} 处改动
            </span>
            <button type="button" className="text-btn" onClick={() => go(c.view as View)}>
              查看
            </button>
          </div>
          {c.items.map((it, i) => (
            <div key={i} className="chg-i">
              <span className="chg-t">{it.time ?? ""}</span>
              <span className="grow min0 ellipsis">{it.title}</span>
              <span className={"chg-tag" + (it.tag === "新增" || it.tag === "完成" || it.tag === "写入" ? " ok" : it.tag === "删除" ? " del" : "")}>{it.tag}</span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function defaultSuggest(o: { tasks: Task[]; nowMin: number; weekday: number; planned: boolean }): string[] {
  if (!o.planned) return [];
  const left = o.tasks.filter((t) => !t.done && t.kind === "work" && t.start != null);
  const cur = left.find((t) => t.start! <= o.nowMin && t.end! > o.nowMin);
  const next = left.find((t) => t.start! > o.nowMin);
  const s: string[] = [];
  if (o.nowMin >= DAY_END - 40) {
    s.push("记今天的日志");
    if (o.weekday === 5) s.push("写本周周报");
    if (left.length) s.push("没做完的挪到明天");
  } else {
    if (cur) s.push(`「${cur.title}」延后半小时`);
    if (next) s.push(`把「${next.title}」拆成小步骤`);
    if (o.weekday === 5 && o.nowMin >= DAY_END - 120) s.push("写本周周报");
    s.push("今天还剩什么");
  }
  return s.slice(0, 3);
}

export default function AgentPanel({ chat, focus, onClose }: Props) {
  const app = useApp();
  const { todayApi: t, ask, say, busy, agents, agent, agentModel, pickAgent, go, now } = app;
  const ref = useRef(app);
  ref.current = app;
  const [draft, setDraft] = useState("");
  const [candDraft, setCandDraft] = useState("");
  const [planning, setPlanning] = useState(false);
  const [working, setWorking] = useState(false);
  const [menu, setMenu] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [chat.length, busy, working]);

  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 132) + "px";
  }, [draft]);

  useEffect(() => {
    if (!menu) return;
    const off = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", off);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", off);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const talk = async (text: string) => {
    setWorking(true);
    try {
      const a = ref.current;
      const { text: state, cache } = await gatherState({ ...a, focus: focus.current?.() ?? "" });
      const history = chat
        .slice(-8)
        .map((m) => (m.role === "me" ? "我：" : decodeWho(m.agent).name + "：") + m.text)
        .join("\n");
      const raw = await a.ask(text, `${state}\n\n【最近对话】\n${history || "无"}\n\n${ACTIONS_PROTOCOL}\n\n我说：${text}`, { hold: true });
      if (!raw) return;
      const { text: body, json } = splitJson(raw);
      const obj = (Array.isArray(json) ? { actions: json } : json) as { actions?: unknown; suggest?: unknown } | null;
      const acts = Array.isArray(obj?.actions) ? (obj!.actions as Action[]) : [];
      const suggest = Array.isArray(obj?.suggest) ? (obj!.suggest as unknown[]).map((x) => String(x ?? "").trim()).filter((x) => x && x.length <= 40).slice(0, 3) : [];
      let cards: ChangeCard[] = [];
      let err = "";
      if (acts.length) {
        const b = ref.current;
        const before = b.todayApi.tasks.slice();
        try {
          const ids = await runActions(acts, { ...b, cache });
          b.bumpData();
          b.flashIds(ids);
          const after = (await api.dayState(b.today)).tasks;
          cards = describeChanges({ acts, today: b.today, before, after, cache, obItems: b.obItems });
        } catch (e) {
          err = "※ " + errText(e);
        }
      }
      await ref.current.say(body || (cards.length ? "已办。" : "好。"), "ai", { cards, suggest });
      if (err) await ref.current.say(err);
    } catch (e) {
      await say("※ " + errText(e));
    } finally {
      setWorking(false);
    }
  };

  const send = async (raw?: string) => {
    const text = (raw ?? draft).trim();
    if (!text || busy || working) return;
    if (raw == null) setDraft("");
    if (t.planned && QUICK.test(text) && text.length < 40) {
      await say(text, "me");
      await say(await t.addText(text));
      return;
    }
    await talk(text);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const confirm = async () => {
    setPlanning(true);
    try {
      const r = await t.confirmPlan();
      await say(r.text);
    } finally {
      setPlanning(false);
    }
  };

  const agentPlan = async () => {
    const picked = t.cands.filter((c) => c.pick);
    if (!picked.length) return;
    setPlanning(true);
    try {
      const list = picked.map((c) => `- id=${c.id} ${c.title}（${c.src}，预估 ${c.minutes} 分钟）`).join("\n");
      const raw = await ask(
        "帮我排一下今天的顺序和时长",
        `今天要做的项目任务：\n${list}\n\n请按优先级排好顺序，给每项一个合理的时长（分钟，10 的倍数），不用解释。最后附 json 代码块：{"order":[{"id":"任务id","minutes":60}]}，必须包含上面全部 id。`,
        { show: (r) => splitJson(r).text },
      );
      if (!raw) return;
      const { json } = splitJson(raw);
      const order = (json as { order?: { id: string; minutes: number }[] } | null)?.order;
      const r = await t.confirmPlan(
        Array.isArray(order) ? order.map((o) => ({ id: String(o.id), minutes: Math.max(10, Math.round(Number(o.minutes) || 30)) })) : undefined,
      );
      await say(r.text);
    } finally {
      setPlanning(false);
    }
  };

  const cycle = (id: string, m: number) => {
    const i = DURS.findIndex((d) => d > m);
    t.setCand(id, { minutes: DURS[i < 0 ? 0 : i] });
  };

  const usable = agents.filter((a) => a.found);
  const locals = usable.filter((a) => a.kind === "local");
  const remotes = usable.filter((a) => a.kind === "api");
  const curWho: Who | null = agent ? { id: agent.id, name: shortName(agent), model: agentModel } : null;
  const lastMsg = chat[chat.length - 1];
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const suggest =
    busy || working
      ? []
      : lastMsg?.role === "ai" && lastMsg.meta?.suggest?.length
        ? lastMsg.meta.suggest
        : !lastMsg || lastMsg.role === "ai"
          ? defaultSuggest({ tasks: t.tasks, nowMin, weekday: now.getDay(), planned: t.planned })
          : [];

  const modelsOf = (a: AgentInfo) => (a.kind === "local" ? ["", ...a.models] : a.models.length ? a.models : a.model ? [a.model] : []);
  const modelOf = (a: AgentInfo) => (a.id === agent?.id ? agentModel : app.settings["agent_model:" + a.id] ?? (a.kind === "api" ? a.model ?? "" : ""));

  const choose = async (a: AgentInfo, model?: string) => {
    await pickAgent(a.id, model);
    if (model != null) setMenu(false);
  };

  const row = (a: AgentInfo) => {
    const on = a.id === agent?.id;
    const open = openId === a.id;
    const ms = modelsOf(a);
    const m = modelOf(a);
    return (
      <div key={a.id} className={"am-item" + (open ? " open" : "") + (on ? " on" : "")}>
        <button
          type="button"
          className="am-row"
          onClick={() => {
            setOpenId(open ? null : a.id);
            if (!on) choose(a);
          }}
        >
          <Avatar who={{ id: a.id, name: a.name, base: a.base }} size="sm" />
          <span className="grow">{a.name}</span>
          {on ? <span className="am-ok">✓</span> : <span className="am-m">{m || "默认"}</span>}
        </button>
        {open && ms.length > 0 && (
          ms.length <= 4 ? (
            <div className="seg-m" role="radiogroup">
              {ms.map((x) => (
                <button key={x || "default"} type="button" role="radio" aria-checked={m === x} className={m === x ? "on" : ""} onClick={() => choose(a, x)}>
                  {x || "默认"}
                </button>
              ))}
            </div>
          ) : (
            <select className="sel-m" value={m} onChange={(e) => choose(a, e.target.value)}>
              {!ms.includes(m) && <option value={m}>{m || "默认"}</option>}
              {ms.map((x) => (
                <option key={x || "default"} value={x}>
                  {x || "默认"}
                </option>
              ))}
            </select>
          )
        )}
      </div>
    );
  };

  return (
    <aside className="claude" aria-label="Agent">
      <div className="claude-head">
        <div className="claude-name">Agent</div>
        <div className="head-r" ref={menuRef}>
          {agent && (
            <button
              type="button"
              className={"am-pick" + (menu ? " on" : "")}
              onClick={() => {
                setOpenId(agent.id);
                setMenu((x) => !x);
              }}
              aria-haspopup="menu"
              aria-expanded={menu}
            >
              <Avatar who={{ id: agent.id, name: agent.name, base: agent.base }} size="sm" />
              <span>{shortName(agent)}</span>
              <span className="am-m">{agentModel || "默认"}</span>
            </button>
          )}
          {menu && (
            <div className="am-menu" role="menu">
              {locals.length > 0 && <div className="am-sec">本机</div>}
              {locals.map(row)}
              {remotes.length > 0 && (
                <>
                  <div className="am-hr" />
                  <div className="am-sec">API</div>
                  {remotes.map(row)}
                </>
              )}
              <div className="am-hr" />
              <button
                type="button"
                className="am-add"
                onClick={() => {
                  setMenu(false);
                  try {
                    sessionStorage.setItem("lg_set_tab", "agent");
                  } catch {}
                  go("settings");
                }}
              >
                ＋ 添加 API
              </button>
            </div>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="收起 Agent 面板">
            ×
          </button>
        </div>
      </div>

      {t.loaded && !t.planned && (
        <div className="plan">
          <div className="ai-text">今天做哪些？</div>
          <div className="cands">
            {t.cands.length === 0 && <div className="muted small pad-y">还没有待办，在下面补一项。</div>}
            {t.cands.map((c) => (
              <div key={c.id} className="cand">
                <Check on={c.pick} top onClick={() => t.setCand(c.id, { pick: !c.pick })} label={"选择：" + c.title} />
                <div className="grow min0">
                  <div className="small">{c.title}</div>
                  <div className={"mono tiny" + (c.late ? " red" : " ink2")}>
                    {c.src} ·{" "}
                    <button type="button" className="inline" onClick={() => cycle(c.id, c.minutes)}>
                      约 {c.minutes} 分钟
                    </button>
                  </div>
                </div>
                <button type="button" className="x" onClick={() => t.dropCand(c.id)} aria-label={"删除：" + c.title}>
                  ×
                </button>
              </div>
            ))}
          </div>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const v = candDraft.trim();
              if (v) t.addCand(v).then(() => setCandDraft(""));
            }}
          >
            <input value={candDraft} onChange={(e) => setCandDraft(e.target.value)} placeholder="再补一项，如 对接接口文档 60分钟" aria-label="再补一项" />
            <button type="submit" className="text-btn">
              补上
            </button>
          </form>
          <button type="button" className="btn solid wide" disabled={planning || busy} onClick={confirm}>
            排进时间流
          </button>
          {agent && (
            <button type="button" className="btn ghost wide" disabled={planning || busy || !t.cands.some((c) => c.pick)} onClick={agentPlan}>
              让 {shortName(agent)} 定顺序和时长
            </button>
          )}
        </div>
      )}

      <div className="chat">
        {chat.map((c, i) => {
          if (c.role === "me")
            return (
              <div key={i} className="msg me">
                <div className="me-text">{c.text}</div>
              </div>
            );
          const w = decodeWho(c.agent);
          const prev = chat[i - 1];
          const same = prev && prev.role === "ai" && (prev.agent ?? "") === (c.agent ?? "");
          const info = agents.find((a) => a.id === w.id);
          return (
            <div key={i} className={"msg ai" + (same ? " cont" : "")}>
              {same ? <span className="av-gap" /> : <Avatar who={{ id: w.id, name: w.name, base: info?.base }} />}
              <div className="grow min0">
                {!same && (
                  <div className="who-line">
                    {w.name}
                    {w.model && <> · {w.model}</>}
                  </div>
                )}
                <div className={"ai-text" + (c.text.startsWith("※") ? " red" : "")}>
                  <Rich text={c.text} go={go} />
                </div>
                {c.meta?.cards && c.meta.cards.length > 0 && <Cards cards={c.meta.cards} go={go} />}
              </div>
            </div>
          );
        })}
        {(busy || working) && curWho && (
          <div className="msg ai">
            <Avatar who={{ id: curWho.id, name: curWho.name, base: agent?.base }} />
            <div className="grow min0">
              <div className="who-line">
                {curWho.name}
                {curWho.model && <> · {curWho.model}</>}
              </div>
              <div className="thinking" aria-label="在想">
                <i />
                <i />
                <i />
              </div>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {agents.length > 0 && !agent && (
        <div className="small ink2 hint-box">
          还没有可用的 Agent。装好 Claude Code、Codex 或 Gemini CLI 后重开流光，或到设置里填一个 API Key。
        </div>
      )}

      {suggest.length > 0 && (
        <div className="sugg" key={suggest.join("|")}>
          {suggest.map((x, i) => (
            <button key={i} type="button" className="sugg-i" style={{ animationDelay: i * 60 + "ms" }} onClick={() => send(x)}>
              {x}
            </button>
          ))}
        </div>
      )}

      <form
        className={"composer" + (draft.trim() ? " has" : "")}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea ref={taRef} rows={1} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} placeholder="跟 Agent 说" aria-label="跟 Agent 说" />
        <button type="submit" className="send" disabled={busy || working || !draft.trim()} aria-label="发送">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
          </svg>
        </button>
      </form>
    </aside>
  );
}

