import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AppCtx, type Ctx, type MailDraft, type View } from "./ctx";
import { api, errText, type AgentInfo, type ChatMeta, type ChatMsg, type MailSummary } from "./lib/api";
import { APP_WHO, encodeWho, shortName } from "./lib/agents";
import { preamble } from "./lib/claude";
import { dayKindLabel, isWorkday } from "./lib/calendar";
import { ensureNotify, notify } from "./lib/notify";
import { readLinks, readObItems, readProfile, readStages } from "./lib/profile";
import { AM_START, DAY_END, WD, applyHours, dayKey, daysBetween, minutesOf, pad, parseDay } from "./lib/time";
import { useToday } from "./today";
import AgentPanel from "./components/AgentPanel";
import Updater from "./components/Updater";
import Setup from "./components/Setup";
import Today from "./views/Today";
import Calendar from "./views/Calendar";
import Report from "./views/Report";
import Onboarding from "./views/Onboarding";
import Mail from "./views/Mail";
import Learn from "./views/Learn";
import Settings from "./views/Settings";

const TITLES: Record<View, string> = {
  today: "今日",
  cal: "日历",
  log: "周报",
  onboard: "入职清单",
  mail: "邮箱",
  learn: "学习路线",
  settings: "设置",
};

const NAV: View[] = ["today", "cal", "log", "onboard", "mail", "learn"];

export default function App() {
  const [now, setNow] = useState(() => new Date());
  const [view, setView] = useState<View>("today");
  const [panelOpen, setPanelOpen] = useState(true);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const focusRef = useRef<(() => string) | null>(null);
  const [mails, setMails] = useState<MailSummary[]>([]);
  const [mailError, setMailError] = useState<string | null>(null);
  const [mailLoading, setMailLoading] = useState(false);
  const [toastText, setToastText] = useState<string | null>(null);
  const [obState, setObState] = useState<Record<string, boolean>>({});
  const [dataVersion, setDataVersion] = useState(0);
  const [flash, setFlash] = useState<Set<string>>(() => new Set());
  const [mailDraft, setMailDraft] = useState<MailDraft | null>(null);
  const toastTimer = useRef<number>(0);
  const flashTimer = useRef<number>(0);

  const s = settings ?? {};
  applyHours(s);

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 20000);
    return () => window.clearInterval(t);
  }, []);

  const today = dayKey(now);
  const nowMin = minutesOf(now);
  const todayApi = useToday(today, nowMin);

  const profile = useMemo(() => readProfile(s), [settings]);
  const links = useMemo(() => readLinks(s), [settings]);
  const obItems = useMemo(() => readObItems(s), [settings]);
  const stages = useMemo(() => readStages(s), [settings]);

  const loadSettings = useCallback(() => api.settingsAll().then(setSettings), []);

  useEffect(() => {
    loadSettings();
    ensureNotify().catch(() => undefined);
  }, [loadSettings]);

  useEffect(() => {
    api.chatList(today).then(setChat);
  }, [today]);

  useEffect(() => {
    api.agents().then(setAgents).catch(() => setAgents([]));
  }, []);

  const refreshAgents = useCallback(async () => {
    setAgents(await api.agentsFresh());
  }, []);

  const usable = agents.filter((a) => a.found);
  const agent = usable.find((a) => a.id === s.agent_current) ?? usable[0] ?? null;
  const agentModel = agent ? (s["agent_model:" + agent.id] ?? (agent.kind === "api" ? agent.model ?? "" : "")) : "";

  useEffect(() => {
    api.onboardingState().then(setObState);
  }, [dataVersion]);

  const toast = useCallback((t: string) => {
    setToastText(t);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastText(null), 3200);
  }, []);

  const setSetting = useCallback(async (k: string, v: string) => {
    await api.settingSet(k, v);
    setSettings((x) => ({ ...(x ?? {}), [k]: v }));
  }, []);

  const bumpData = useCallback(() => setDataVersion((v) => v + 1), []);

  const flashIds = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setFlash(new Set(ids));
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(new Set()), 1800);
  }, []);

  const push = useCallback(
    async (m: ChatMsg) => {
      setChat((c) => [...c, m].slice(-60));
      await api.chatAdd(today, m);
    },
    [today],
  );

  const who = agent ? encodeWho({ id: agent.id, name: shortName(agent), model: agentModel }) : encodeWho(APP_WHO);

  const ask = useCallback<Ctx["ask"]>(
    async (label, prompt, opts) => {
      setPanelOpen(true);
      await push({ role: "me", text: label });
      if (!agent) {
        await push({ role: "ai", text: "※ 还没有可用的 Agent，到设置里接入一个。", agent: encodeWho(APP_WHO) });
        return null;
      }
      setBusy(true);
      try {
        const raw = await api.agentAsk(agent.id, agentModel, preamble(profile, new Date()) + "\n\n" + prompt);
        if (!opts?.hold) await push({ role: "ai", text: opts?.show ? opts.show(raw) : raw, agent: who });
        return raw;
      } catch (e) {
        await push({ role: "ai", text: "※ " + errText(e), agent: who });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [profile, push, agent, agentModel, who],
  );

  const say = useCallback(
    async (text: string, role: "me" | "ai" = "ai", meta?: ChatMeta) =>
      push(role === "me" ? { role, text } : { role, text, agent: meta ? who : encodeWho(APP_WHO), meta: meta ?? null }),
    [push, who],
  );

  const refreshMail = useCallback(async () => {
    setMailLoading(true);
    try {
      const list = await api.mailList("INBOX", 80);
      setMails(list);
      setMailError(null);
    } catch (e) {
      setMailError(errText(e));
    } finally {
      setMailLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let first = true;
    const tick = async () => {
      const cfg = await api.mailConfig().catch(() => null);
      if (!alive || !cfg?.hasPassword || !cfg.address) return;
      if (first) {
        first = false;
        const c = await api.mailCached("INBOX").catch(() => null);
        if (alive && c?.list.length) setMails((m) => (m.length ? m : c.list));
      }
      refreshMail();
    };
    tick();
    const t = window.setInterval(tick, 10 * 60 * 1000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [refreshMail]);

  const reminded = useRef<Record<string, boolean>>({});
  useEffect(() => {
    if (!settings || !isWorkday(now)) return;
    const slots: [string, number, string, string][] = [
      ["in1", AM_START - 5, "punch_in:", "快上班了，记得打卡"],
      ["in2", AM_START + 5, "punch_in:", "上班卡还没记，打了的话在流光里点一下「记一下」"],
      ["out1", DAY_END, "punch_out:", "下班了，记得打卡"],
      ["out2", DAY_END + 10, "punch_out:", "下班卡还没记，打了的话在流光里点一下「记一下」"],
    ];
    for (const [id, at, key, body] of slots) {
      const k = today + id;
      if (nowMin >= at && nowMin < at + 10 && !s[key + today] && !reminded.current[k]) {
        reminded.current[k] = true;
        notify(body);
      }
    }
  }, [nowMin, today, settings]);

  const markSeen = useCallback((uid: number) => setMails((ms) => ms.map((m) => (m.uid === uid ? { ...m, seen: true } : m))), []);
  const setFocus = useCallback((f: (() => string) | null) => {
    focusRef.current = f;
  }, []);

  if (!settings) return null;
  if (settings.setup_done !== "1")
    return (
      <Setup
        settings={settings}
        onDone={async () => {
          await loadSettings();
          bumpData();
        }}
      />
    );

  const unread = mails.filter((m) => !m.seen).length;
  const obLeft = obItems.filter((o) => !obState[o.id]).length;
  const dayNo = profile.joinDate ? daysBetween(parseDay(profile.joinDate), now) + 1 : 0;
  const dateLine = [
    `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())} ${WD[now.getDay()]}`,
    dayKindLabel(now),
    dayNo > 0 && dayNo <= 400 ? `入职第 ${dayNo} 天` : "",
    profile.project,
  ]
    .filter(Boolean)
    .join(" · ");

  const ctx: Ctx = {
    now,
    today,
    view,
    go: setView,
    profile,
    links,
    obItems,
    stages,
    settings,
    setSetting,
    todayApi,
    ask,
    say,
    agents,
    agent,
    agentModel,
    pickAgent: async (id: string, model?: string) => {
      await setSetting("agent_current", id);
      if (model != null) await setSetting("agent_model:" + id, model);
    },
    refreshAgents,
    busy,
    setFocus,
    openAgent: () => setPanelOpen(true),
    mails,
    mailError,
    mailLoading,
    refreshMail,
    markSeen,
    toast,
    obState,
    dataVersion,
    bumpData,
    flash,
    flashIds,
    mailDraft,
    setMailDraft,
  };

  const startDrag = (e: React.MouseEvent) => {
    if (e.button === 0 && e.target === e.currentTarget) getCurrentWindow().startDragging();
  };

  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell">
        <div className="dragbar" onMouseDown={startDrag} />
        <nav className="nav" aria-label="主导航">
          <div className="brand">
            <div className="brand-name">流光</div>
            <div className="brand-sub">
              {profile.name}
              {dayNo > 0 && dayNo <= 400 ? ` · No.${pad(dayNo)}` : ""}
            </div>
          </div>
          <div className="nav-list">
            {NAV.map((v, i) => (
              <button key={v} type="button" className={"nav-item" + (view === v ? " on" : "")} onClick={() => setView(v)}>
                <span className="nav-no">{pad(i + 1)}</span>
                <span className="grow">{TITLES[v]}</span>
                {v === "onboard" && obLeft > 0 && <span className="nav-meta">{obLeft}</span>}
                {v === "mail" && unread > 0 && <span className="nav-meta red">{unread} 新</span>}
              </button>
            ))}
          </div>
          <div className="grow" />
          <div className="links">
            {links.length > 0 && <div className="label">快捷入口</div>}
            {links.map((l, i) => (
              <button key={i} type="button" className="link" onClick={() => openUrl(l.url).catch((e) => toast(errText(e)))}>
                {l.label}
                <span>↗</span>
              </button>
            ))}
            <button type="button" className={"link settings-link" + (view === "settings" ? " on" : "")} onClick={() => setView("settings")}>
              设置<span>›</span>
            </button>
          </div>
        </nav>

        <main className="main">
          <header className="head">
            <h1 key={view} className="view-title">
              {TITLES[view]}
            </h1>
            <div className="date-line grow tline">{dateLine}</div>
            <button type="button" className="btn ghost sm" onClick={() => setPanelOpen((o) => !o)}>
              {panelOpen ? "收起 Agent" : "问 Agent"}
            </button>
          </header>
          <div key={view} className="view">
            {view === "today" && <Today />}
            {view === "cal" && <Calendar />}
            {view === "log" && <Report />}
            {view === "onboard" && <Onboarding />}
            {view === "mail" && <Mail />}
            {view === "learn" && <Learn />}
            {view === "settings" && <Settings />}
          </div>
        </main>

        {panelOpen && <AgentPanel chat={chat} focus={focusRef} onClose={() => setPanelOpen(false)} />}
        <Updater />
        {toastText && <div className="toast">{toastText}</div>}
      </div>
    </AppCtx.Provider>
  );
}
