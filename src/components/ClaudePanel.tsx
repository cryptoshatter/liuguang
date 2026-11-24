import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useApp } from "../ctx";
import { api, errText, type ChatMsg } from "../lib/api";
import { ACTIONS_PROTOCOL, splitJson } from "../lib/claude";
import { gatherState, runActions, type Action } from "../lib/assistant";
import Check from "./Check";

const DURS = [20, 30, 45, 60, 90, 120, 180, 240];
const QUICK = /^(帮我)?(下午|上午)?(再)?(加|新增|添加)|^\d{1,2}[:：]\d{2}/;

type Props = { chat: ChatMsg[]; focus: MutableRefObject<(() => string) | null>; onClose: () => void };

export default function ClaudePanel({ chat, focus, onClose }: Props) {
  const app = useApp();
  const { todayApi: t, ask, say, busy } = app;
  const ref = useRef(app);
  ref.current = app;
  const [status, setStatus] = useState<{ found: boolean; path: string | null } | null>(null);
  const [draft, setDraft] = useState("");
  const [candDraft, setCandDraft] = useState("");
  const [planning, setPlanning] = useState(false);
  const [working, setWorking] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.claudeStatus().then(setStatus).catch(() => setStatus({ found: false, path: null }));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [chat.length, busy, working]);

  const talk = async (text: string) => {
    setWorking(true);
    try {
      const a = ref.current;
      const { text: state, cache } = await gatherState({ ...a, focus: focus.current?.() ?? "" });
      const history = chat
        .slice(-8)
        .map((m) => (m.role === "me" ? "我：" : "Claude：") + m.text)
        .join("\n");
      const raw = await a.ask(text, `${state}\n\n【最近对话】\n${history || "无"}\n\n${ACTIONS_PROTOCOL}\n\n我说：${text}`, {
        show: (r) => splitJson(r).text || "已办。",
      });
      if (!raw) return;
      const { json } = splitJson(raw);
      const acts = Array.isArray(json) ? json : (json as { actions?: unknown } | null)?.actions;
      if (Array.isArray(acts) && acts.length) {
        const b = ref.current;
        try {
          const ids = await runActions(acts as Action[], { ...b, cache });
          b.bumpData();
          b.flashIds(ids);
        } catch (e) {
          await b.say("※ " + errText(e));
        }
      }
    } catch (e) {
      await say("※ " + errText(e));
    } finally {
      setWorking(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || working) return;
    setDraft("");
    if (t.planned && QUICK.test(text) && text.length < 40) {
      await say(text, "me");
      await say(await t.addText(text));
      return;
    }
    if (t.planned && /^(把没做完的)?(顺延|重排|往后排?)/.test(text) && text.length < 16) {
      await say(text, "me");
      await say(await t.reflowNow());
      return;
    }
    await talk(text);
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

  const claudePlan = async () => {
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

  return (
    <aside className="claude" aria-label="Claude 助手">
      <div className="claude-head">
        <div>
          <div className="claude-name">Claude</div>
          <div className={"claude-status" + (status && !status.found ? " off" : "")}>
            {status == null ? "…" : status.found ? "● 本机 Claude Code" : "○ 未找到 Claude Code"}
          </div>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="收起 Claude 面板">
          ×
        </button>
      </div>

      {t.loaded && !t.planned && (
        <div className="plan">
          <span className="who ai">Claude</span>
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
          {status?.found && (
            <button type="button" className="btn ghost wide" disabled={planning || busy || !t.cands.some((c) => c.pick)} onClick={claudePlan}>
              让 Claude 定顺序和时长
            </button>
          )}
        </div>
      )}

      <div className="chat">
        {chat.map((c, i) => (
          <div key={i} className="msg">
            <span className={"who " + c.role}>{c.role === "me" ? "我" : "Claude"}</span>
            <div className={c.role === "me" ? "me-text" : "ai-text"}>{c.text}</div>
          </div>
        ))}
        {(busy || working) && (
          <div className="msg">
            <span className="who ai">Claude</span>
            <div className="ai-text thinking" aria-label="在想">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {status && !status.found && (
        <div className="small ink2 hint-box">
          要用 Claude，先在终端装好 Claude Code 并登录一次，然后重开流光。装在特殊位置的话，到设置里填路径。
        </div>
      )}

      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="跟 Claude 说" aria-label="跟 Claude 说" />
        <button type="submit" className="btn solid" disabled={busy || working}>
          发送
        </button>
      </form>
    </aside>
  );
}
