import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { findUpdate } from "../components/Updater";
import AgentSettings from "../components/AgentSettings";
import { useApp } from "../ctx";
import { DEFAULT_REPORT_HEAD, importBundle, type Link } from "../lib/profile";
import { api, errText, type DataInfo, type MailConfig } from "../lib/api";
import { DEFAULT_HOURS, WD, parseDay, parseHM } from "../lib/time";

async function buildMarkdown(leader: string) {
  const [tasks, notes] = await Promise.all([api.tasksRange("0000-00-00", "9999-99-99"), api.notesRange("0000-00-00", "9999-99-99")]);
  const days = Array.from(new Set([...tasks.filter((t) => t.done && t.kind === "work").map((t) => t.day!), ...notes.map((n) => n.day)])).sort();
  const out: string[] = ["# 工作日志", ""];
  for (const d of days) {
    out.push(`## ${d} ${WD[parseDay(d).getDay()]}`, "");
    tasks.filter((t) => t.day === d && t.done && t.kind === "work").forEach((t) => out.push("- " + t.title));
    notes.filter((n) => n.day === d).forEach((n) => out.push("- " + n.text));
    out.push("");
  }
  const weeks = Array.from(new Set(days.map((d) => {
    const x = parseDay(d);
    const m = new Date(x.getFullYear(), x.getMonth(), x.getDate() - ((x.getDay() + 6) % 7));
    return m.getFullYear() + "-" + String(m.getMonth() + 1).padStart(2, "0") + "-" + String(m.getDate()).padStart(2, "0");
  })));
  const reports: string[] = [];
  for (const w of weeks) {
    const r = await api.reportGet(w);
    if (r) reports.push(`## ${w} 当周`, "", r, "");
  }
  if (reports.length) out.push(`# 周报（致 ${leader}）`, "", ...reports);
  return out.join("\n");
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
  </label>
);

const TABS: [string, string][] = [
  ["me", "个人与作息"],
  ["links", "快捷入口"],
  ["mail", "邮箱"],
  ["agent", "Agent"],
  ["data", "数据与更新"],
];
const lastTab = { v: "me" };
const wantTab = () => {
  try {
    const v = sessionStorage.getItem("lg_set_tab");
    sessionStorage.removeItem("lg_set_tab");
    return v;
  } catch {
    return null;
  }
};

export default function Settings() {
  const [tab, setTab] = useState(() => (lastTab.v = wantTab() ?? lastTab.v));
  const pickTab = (k: string) => {
    lastTab.v = k;
    setTab(k);
  };
  const { settings, setSetting, toast, profile, refreshMail, links, obState, bumpData } = useApp();
  const [cfg, setCfg] = useState<MailConfig | null>(null);
  const [pw, setPw] = useState("");
  const [mailMsg, setMailMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [detectLog, setDetectLog] = useState<string[]>([]);
  const [info, setInfo] = useState<DataInfo | null>(null);
  const [version, setVersion] = useState("");
  const [names, setNames] = useState({ user: profile.name, leader: profile.leader, project: profile.project, join: profile.joinDate, about: profile.about, head: profile.reportHead });
  const [hours, setHours] = useState(() => {
    const p = (k: keyof typeof DEFAULT_HOURS) => {
      const v = settings[k] || DEFAULT_HOURS[k];
      return /^\d:\d\d$/.test(v) ? "0" + v : v;
    };
    return { work_start: p("work_start"), lunch_start: p("lunch_start"), lunch_end: p("lunch_end"), work_end: p("work_end") };
  });
  const [linkList, setLinkList] = useState<Link[]>(links);
  const fileRef = useRef<HTMLInputElement>(null);

  const saveHour = (k: keyof typeof hours, v: string) => {
    const n = { ...hours, [k]: v };
    setHours(n);
    const m = Object.values(n).map((x) => parseHM(x));
    if (m.every((x) => x != null) && m[0]! < m[1]! && m[1]! <= m[2]! && m[2]! < m[3]!) setSetting(k, v);
  };

  const saveLinks = (l: Link[]) => {
    setLinkList(l);
    setSetting("links", JSON.stringify(l.filter((x) => x.url.trim()).map((x) => ({ label: x.label.trim() || x.url.trim(), url: x.url.trim() }))));
  };

  const importFile = async (file: File) => {
    try {
      const n = await importBundle(await file.text(), setSetting, (id) => api.onboardingSet(id, true), obState);
      bumpData();
      toast(`已导入 ${n} 项设置`);
    } catch (e) {
      toast(errText(e));
    }
  };

  useEffect(() => {
    api.mailConfig().then((c) => setCfg({ ...c, login: c.login || c.address, name: c.name || profile.name }));
    api.dataInfo().then(setInfo);
    getVersion().then(setVersion);
  }, []);

  const saveMail = async (test: boolean) => {
    if (!cfg) return;
    setMailMsg(null);
    try {
      await api.mailSaveConfig(cfg, pw || null);
      setPw("");
      const c = await api.mailConfig();
      setCfg(c);
      if (test) {
        setTesting(true);
        setMailMsg(await api.mailTest());
        refreshMail();
      } else setMailMsg("已保存。");
    } catch (e) {
      setMailMsg("※ " + errText(e));
    } finally {
      setTesting(false);
    }
  };

  const detect = async () => {
    if (!cfg) return;
    setMailMsg(null);
    setDetectLog([]);
    setTesting(true);
    try {
      await api.mailSaveConfig(cfg, pw || null);
      setPw("");
      const r = await api.mailDetect();
      setDetectLog(r.log);
      setCfg({ ...r.config, hasPassword: true });
      setMailMsg(r.ok ? r.summary : "※ " + r.summary);
      if (r.ok) refreshMail();
    } catch (e) {
      setMailMsg("※ " + errText(e));
    } finally {
      setTesting(false);
    }
  };

  const exportAll = async () => {
    try {
      const md = await buildMarkdown(profile.leader);
      const dir = await api.exportAll(md);
      toast("已导出到 文稿/流光导出");
      revealItemInDir(dir);
    } catch (e) {
      toast(errText(e));
    }
  };

  const backup = async () => {
    try {
      await api.backupNow();
      setInfo(await api.dataInfo());
      toast("已备份");
    } catch (e) {
      toast(errText(e));
    }
  };

  return (
    <div className="settings">
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={"tab" + (tab === k ? " on" : "")} onClick={() => pickTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "me" && (
      <>
      <section className="set-sec">
        <h2>个人</h2>
        <div className="fields">
          <Field label="我的名字">
            <input className="line-input" value={names.user} onChange={(e) => setNames({ ...names, user: e.target.value })} onBlur={() => setSetting("user_name", names.user.trim())} />
          </Field>
          <Field label="周报发给">
            <input className="line-input" value={names.leader} onChange={(e) => setNames({ ...names, leader: e.target.value })} onBlur={() => setSetting("leader_name", names.leader.trim())} />
          </Field>
          <Field label="所在项目">
            <input className="line-input" value={names.project} onChange={(e) => setNames({ ...names, project: e.target.value })} onBlur={() => setSetting("project_name", names.project.trim())} />
          </Field>
          <Field label="入职日期">
            <input className="line-input" type="date" value={names.join} onChange={(e) => setNames({ ...names, join: e.target.value })} onBlur={() => setSetting("join_date", names.join)} />
          </Field>
          <Field label="关于我">
            <input className="line-input" value={names.about} onChange={(e) => setNames({ ...names, about: e.target.value })} onBlur={() => setSetting("about", names.about.trim())} placeholder="如 做数据开发，正在学 SQL" />
          </Field>
          <Field label="周报开头">
            <input
              className="line-input"
              value={names.head}
              onChange={(e) => setNames({ ...names, head: e.target.value })}
              onBlur={() => setSetting("report_head", names.head.trim() || DEFAULT_REPORT_HEAD)}
            />
          </Field>
        </div>
      </section>

      <section className="set-sec">
        <h2>作息</h2>
        <div className="fields four">
          <Field label="上班">
            <input className="line-input" type="time" value={hours.work_start} onChange={(e) => saveHour("work_start", e.target.value)} />
          </Field>
          <Field label="午休开始">
            <input className="line-input" type="time" value={hours.lunch_start} onChange={(e) => saveHour("lunch_start", e.target.value)} />
          </Field>
          <Field label="午休结束">
            <input className="line-input" type="time" value={hours.lunch_end} onChange={(e) => saveHour("lunch_end", e.target.value)} />
          </Field>
          <Field label="下班">
            <input className="line-input" type="time" value={hours.work_end} onChange={(e) => saveHour("work_end", e.target.value)} />
          </Field>
        </div>
      </section>

      </>
      )}

      {tab === "links" && (
      <section className="set-sec">
        <h2>快捷入口</h2>
        {linkList.map((l, i) => (
          <div key={i} className="pair link-edit">
            <input className="line-input" value={l.label} placeholder="名字" onChange={(e) => setLinkList(linkList.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} onBlur={() => saveLinks(linkList)} />
            <input className="line-input" value={l.url} placeholder="https://" onChange={(e) => setLinkList(linkList.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} onBlur={() => saveLinks(linkList)} />
            <button type="button" className="x" onClick={() => saveLinks(linkList.filter((_, j) => j !== i))} aria-label="删除这个入口">
              ×
            </button>
          </div>
        ))}
        <div className="row-btns">
          <button type="button" className="btn ghost" onClick={() => setLinkList([...linkList, { label: "", url: "" }])}>
            加一个
          </button>
        </div>
      </section>

      )}

      {tab === "mail" && (
      <section className="set-sec">
        <h2>邮箱</h2>
        {cfg && (
          <>
            <div className="fields">
              <Field label="邮箱地址">
                <input className="line-input" value={cfg.address} onChange={(e) => setCfg({ ...cfg, address: e.target.value })} />
              </Field>
              <Field label="登录名">
                <input className="line-input" value={cfg.login} onChange={(e) => setCfg({ ...cfg, login: e.target.value })} />
              </Field>
              <Field label="发件人名字">
                <input className="line-input" value={cfg.name} onChange={(e) => setCfg({ ...cfg, name: e.target.value })} />
              </Field>
              <Field label={cfg.hasPassword ? "密码（已存钥匙串）" : "密码"}>
                <input className="line-input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={cfg.hasPassword ? "不改就留空" : ""} />
              </Field>
              <Field label="收信服务器 IMAP">
                <div className="pair">
                  <input className="line-input" value={cfg.imapHost} onChange={(e) => setCfg({ ...cfg, imapHost: e.target.value })} />
                  <input className="line-input port" value={cfg.imapPort} onChange={(e) => setCfg({ ...cfg, imapPort: Number(e.target.value) || 0 })} />
                  <select className="line-input sec" value={cfg.imapSecurity} onChange={(e) => setCfg({ ...cfg, imapSecurity: e.target.value })} aria-label="收信加密方式">
                    <option value="ssl">SSL</option>
                    <option value="starttls">STARTTLS</option>
                    <option value="plain">不加密</option>
                  </select>
                </div>
              </Field>
              <Field label="发信服务器 SMTP">
                <div className="pair">
                  <input className="line-input" value={cfg.smtpHost} onChange={(e) => setCfg({ ...cfg, smtpHost: e.target.value })} />
                  <input className="line-input port" value={cfg.smtpPort} onChange={(e) => setCfg({ ...cfg, smtpPort: Number(e.target.value) || 0 })} />
                  <select className="line-input sec" value={cfg.smtpSecurity} onChange={(e) => setCfg({ ...cfg, smtpSecurity: e.target.value })} aria-label="发信加密方式">
                    <option value="ssl">SSL</option>
                    <option value="starttls">STARTTLS</option>
                    <option value="plain">不加密</option>
                  </select>
                </div>
              </Field>
            </div>
            <label className="checkline small">
              <input type="checkbox" checked={cfg.insecure} onChange={(e) => setCfg({ ...cfg, insecure: e.target.checked })} />
              信任自签名证书
            </label>
            <div className="row-btns">
              <button type="button" className="btn solid" onClick={() => saveMail(true)} disabled={testing}>
                {testing ? "连接中" : "保存并测试"}
              </button>
              <button type="button" className="btn ghost" onClick={detect} disabled={testing}>
                自动检测
              </button>
              <button type="button" className="btn ghost" onClick={() => saveMail(false)}>
                只保存
              </button>
            </div>
            {mailMsg && <div className={"small" + (mailMsg.startsWith("※") ? " red" : " ink2")}>{mailMsg}</div>}
            {detectLog.length > 0 && (
              <div className="detect-log mono tiny">
                {detectLog.map((l, i) => (
                  <div key={i} className={l.startsWith("✓") ? "" : "ink2"}>
                    {l}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      )}

      {tab === "agent" && (
      <AgentSettings />

      )}

      {tab === "data" && (
      <>
      <section className="set-sec">
        <h2>数据</h2>
        {info && (
          <div className="small lh">
            <div className="mono">{info.dataDir}</div>
            <div className="ink2">
              备份 {info.backups} 份{info.lastBackup ? " · 最近 " + info.lastBackup : ""}
            </div>
          </div>
        )}
        <div className="row-btns">
          <button type="button" className="btn ghost" onClick={backup}>
            立即备份
          </button>
          <button type="button" className="btn ghost" onClick={() => info && revealItemInDir(info.dataDir + "/liuguang.db")}>
            打开数据文件夹
          </button>
          <button type="button" className="btn ghost" onClick={exportAll}>
            导出 Markdown 和 JSON
          </button>
          <button type="button" className="btn ghost" onClick={() => fileRef.current?.click()}>
            导入配置文件
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile(f);
              e.target.value = "";
            }}
          />
        </div>
      </section>

      <label className="checkline small">
        <input
          type="checkbox"
          checked={settings.auto_update !== "0"}
          onChange={async (e) => {
            await setSetting("auto_update", e.target.checked ? "1" : "0");
            if (e.target.checked) window.dispatchEvent(new Event("lg-auto-update"));
          }}
        />
        自动更新
      </label>
      <div className="row-btns">
        <span className="mono tiny ink2">流光 {version}</span>
        <button
          type="button"
          className="text-btn"
          onClick={async () => {
            try {
              const u = await findUpdate();
              if (u) window.dispatchEvent(new CustomEvent("lg-update", { detail: u }));
              else toast("已经是最新版");
            } catch (e) {
              toast("检查更新失败：" + errText(e));
            }
          }}
        >
          检查更新
        </button>
      </div>
      </>
      )}
    </div>
  );
}
