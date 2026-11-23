import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AppCtx, type Ctx, type PanelSpec, type View } from "./ctx";
import { api, errText, type ChatMsg, type MailSummary } from "./lib/api";
import { preamble, type Profile } from "./lib/claude";
import { dayKindLabel, isWorkday } from "./lib/calendar";
import { ensureNotify, notify } from "./lib/notify";
import { JOIN_DATE, ONBOARDING_ITEMS } from "./lib/onboarding";
import { WD, dayKey, daysBetween, minutesOf, pad, parseDay } from "./lib/time";
import { useToday } from "./today";
import ClaudePanel from "./components/ClaudePanel";
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

const LINKS = [
  { label: "禅道", url: "http://zentao.sunyard.com.cn:9788/" },
  { label: "数字化平台", url: "https://edmp.sunyard.com.cn:9443/" },
  { label: "网页邮箱", url: "http://mail.sunyard.com" },
];

export default function App() {
  const [now, setNow] = useState(() => new Date());
  const [view, setView] = useState<View>("today");
  const [claudeOpen, setClaudeOpen] = useState(true);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<PanelSpec>({ chips: [] });
  const [mails, setMails] = useState<MailSummary[]>([]);
  const [mailError, setMailError] = useState<string | null>(null);
  const [mailLoading, setMailLoading] = useState(false);
  const [toastText, setToastText] = useState<string | null>(null);
  const [punchTip, setPunchTip] = useState(false);
  const [obState, setObState] = useState<Record<string, boolean>>({});
  const [obVersion, setObVersion] = useState(0);
  const toastTimer = useRef<number>(0);

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 20000);
    return () => window.clearInterval(t);
  }, []);

  const today = dayKey(now);
  const nowMin = minutesOf(now);
  const todayApi = useToday(today, nowMin);

  const profile: Profile = useMemo(
    () => ({
      name: settings.user_name || "贺萧",
      leader: settings.leader_name || "谭鸿",
      project: settings.project_name || "乐山商行项目",
    }),
    [settings],
  );

  useEffect(() => {
    api.settingsAll().then(setSettings);
    ensureNotify().catch(() => undefined);
  }, []);

  useEffect(() => {
    api.chatList(today).then(setChat);
  }, [today]);

  useEffect(() => {
    api.onboardingState().then(setObState);
  }, [obVersion]);

  const toast = useCallback((s: string) => {
    setToastText(s);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastText(null), 3200);
  }, []);

  const setSetting = useCallback(async (k: string, v: string) => {
    await api.settingSet(k, v);
    setSettings((s) => ({ ...s, [k]: v }));
  }, []);

  const push = useCallback(
    async (role: "me" | "ai", text: string) => {
      setChat((c) => [...c, { role, text }].slice(-40));
      await api.chatAdd(today, role, text);
    },
    [today],
  );

  const ask = useCallback<Ctx["ask"]>(
    async (label, prompt, opts) => {
      setClaudeOpen(true);
      await push("me", label);
      setBusy(true);
      try {
        const raw = await api.claudeAsk(preamble(profile, new Date()) + "\n\n" + prompt);
        await push("ai", opts?.show ? opts.show(raw) : raw);
        return raw;
      } catch (e) {
        await push("ai", "※ " + errText(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [profile, push],
  );

  const say = useCallback(async (text: string, role: "me" | "ai" = "ai") => push(role, text), [push]);

  const refreshMail = useCallback(async () => {
    setMailLoading(true);
    try {
      const list = await api.mailList(60);
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
    const tick = async () => {
      const cfg = await api.mailConfig().catch(() => null);
      if (alive && cfg?.hasPassword && cfg.address) refreshMail();
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
    if (!isWorkday(now)) return;
    const slots: [string, number, string, string][] = [
      ["in1", 535, "punch_in:", "快 9 点了，记得上班打卡"],
      ["in2", 545, "punch_in:", "上班卡还没记，打了的话在流光里点一下「记一下」"],
      ["out1", 1080, "punch_out:", "18:00 了，记得下班打卡"],
      ["out2", 1090, "punch_out:", "下班卡还没记，打了的话在流光里点一下「记一下」"],
    ];
    for (const [id, at, key, body] of slots) {
      const k = today + id;
      if (nowMin >= at && nowMin < at + 10 && !settings[key + today] && !reminded.current[k]) {
        reminded.current[k] = true;
        notify(body);
      }
    }
  }, [nowMin, today, settings]);

  const markSeen = useCallback((uid: number) => setMails((ms) => ms.map((m) => (m.uid === uid ? { ...m, seen: true } : m))), []);

  const unread = mails.filter((m) => !m.seen).length;
  const obLeft = ONBOARDING_ITEMS.filter((o) => !obState[o.id]).length;
  const dayNo = Math.max(1, daysBetween(parseDay(JOIN_DATE), now) + 1);
  const dateLine = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())} ${WD[now.getDay()]} · ${dayKindLabel(now)} · 入职第 ${dayNo} 天 · ${profile.project}`;

  const ctx: Ctx = {
    now,
    today,
    view,
    go: setView,
    profile,
    settings,
    setSetting,
    todayApi,
    ask,
    say,
    busy,
    setPanel,
    openClaude: () => setClaudeOpen(true),
    mails,
    mailError,
    mailLoading,
    refreshMail,
    markSeen,
    toast,
    obVersion,
    bumpOb: () => setObVersion((v) => v + 1),
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
              {profile.name} · No.{pad(dayNo)}
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
            <div className="label">快捷入口</div>
            <button type="button" className="link" onClick={() => openUrl(LINKS[0].url)}>
              禅道<span>↗</span>
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setPunchTip(true);
                openUrl("weixin://").catch(() => undefined);
              }}
            >
              打卡<span>↗</span>
            </button>
            {LINKS.slice(1).map((l) => (
              <button key={l.label} type="button" className="link" onClick={() => openUrl(l.url)}>
                {l.label}
                <span>↗</span>
              </button>
            ))}
            {punchTip && <div className="punch-tip">已打开微信：「信雅达数字化管理平台」公众号 › 打卡</div>}
            <button type="button" className={"link settings-link" + (view === "settings" ? " on" : "")} onClick={() => setView("settings")}>
              设置<span>›</span>
            </button>
          </div>
        </nav>

        <main className="main">
          <header className="head">
            <div>
              <div className="date-line">{dateLine}</div>
              <h1>{TITLES[view]}</h1>
            </div>
            <button type="button" className="btn ghost" onClick={() => setClaudeOpen((o) => !o)}>
              {claudeOpen ? "收起 Claude" : "问 Claude"}
            </button>
          </header>
          {view === "today" && <Today obState={obState} />}
          {view === "cal" && <Calendar />}
          {view === "log" && <Report />}
          {view === "onboard" && <Onboarding state={obState} />}
          {view === "mail" && <Mail />}
          {view === "learn" && <Learn />}
          {view === "settings" && <Settings />}
        </main>

        {claudeOpen && <ClaudePanel chat={chat} panel={panel} onClose={() => setClaudeOpen(false)} />}
        {toastText && <div className="toast">{toastText}</div>}
      </div>
    </AppCtx.Provider>
  );
}
