import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useApp, useFocus } from "../ctx";
import { api, errText, type MailConfig, type MailDetail, type MailFolder, type MailSummary } from "../lib/api";
import { redact } from "../lib/claude";
import AddrInput, { harvestContacts } from "../components/AddrInput";
import { dayKey, pad } from "../lib/time";

const when = (ts: number, now: Date, full = false) => {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
  if (dayKey(d) === dayKey(now)) return full ? "今天 " + hm : hm;
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(d) === dayKey(y)) return "昨天" + (full ? " " + hm : "");
  const md = (d.getFullYear() !== now.getFullYear() ? d.getFullYear() + "/" : "") + (d.getMonth() + 1) + "/" + d.getDate();
  return full ? md + " " + hm : md;
};

const COLORS = ["#a8392a", "#3d5a47", "#4f5f82", "#8a6a34", "#6b4f7a", "#2f6b70", "#9a5a3a", "#5a564e"];

function Avatar({ name, addr, size = 34 }: { name: string; addr: string; size?: number }) {
  const key = (addr || name).toLowerCase();
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const label = (name || addr || "?").trim();
  const ch = /^[一-龥]/.test(label) ? label[0] : label[0]?.toUpperCase() ?? "?";
  return (
    <span className="avatar" style={{ width: size, height: size, background: COLORS[h % COLORS.length], fontSize: size * 0.44 }} aria-hidden="true">
      {ch}
    </span>
  );
}

type Compose = { kind: "new" | "reply" | "all" | "fwd"; to: string; cc: string; subject: string; body: string; inReplyTo: string | null; references: string[]; quote: string };
const emptyCompose = (): Compose => ({ kind: "new", to: "", cc: "", subject: "", body: "", inReplyTo: null, references: [], quote: "" });
const splitAddrs = (s: string) =>
  s
    .split(/[,，;；\n]+/)
    .flatMap((t) => (t.includes("<") ? [t.trim()] : t.split(/\s+/)))
    .filter(Boolean);
const ICON: Record<string, string> = { inbox: "收", drafts: "稿", sent: "发", trash: "删", junk: "垃", other: "夹" };

const frameDoc = (html: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;padding:0;background:#fffdf8;color:#1f1d1a;font:14px/1.7 "PingFang SC",system-ui,sans-serif;word-wrap:break-word}body{padding:4px 2px 24px}img{max-width:100%;height:auto}table{max-width:100%}a{color:#a8392a}blockquote{margin:8px 0;padding-left:12px;border-left:2px solid #d6cebd;color:#5e584d}</style></head><body>${html}</body></html>`;

const textToHtml = (t: string) =>
  t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, "<br>");

function Body({ detail }: { detail: MailDetail }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(200);
  const src = useMemo(() => frameDoc(detail.html ? redact(detail.html) : textToHtml(redact(detail.text))), [detail]);
  const fit = () => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    setH(Math.max(120, doc.documentElement.scrollHeight + 8));
    doc.querySelectorAll("img").forEach((img) => img.addEventListener("load", () => setH(Math.max(120, doc.documentElement.scrollHeight + 8))));
    doc.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("a");
      if (a?.href && /^(https?|mailto):/.test(a.href)) {
        e.preventDefault();
        openUrl(a.href).catch(() => undefined);
      }
    });
  };
  return <iframe ref={ref} className="mail-frame" title="邮件正文" sandbox="allow-same-origin" srcDoc={src} style={{ height: h }} onLoad={fit} />;
}

const memo: {
  cfg: MailConfig | null;
  folders: MailFolder[];
  folder: string;
  lists: Record<string, MailSummary[]>;
  sel: number | null;
  detail: MailDetail | null;
  details: Map<string, MailDetail>;
  fresh: Record<string, number>;
} = { cfg: null, folders: [], folder: "INBOX", lists: {}, sel: null, detail: null, details: new Map(), fresh: {} };

const dkey = (folder: string, uid: number) => folder + "|" + uid;

export default function Mail() {
  const { now, go, toast, profile, mailDraft, setMailDraft, markSeen, refreshMail } = useApp();
  const [cfg, setCfg] = useState<MailConfig | null>(memo.cfg);
  const [folders, setFolders] = useState<MailFolder[]>(memo.folders);
  const [folder, setFolder] = useState(memo.folder);
  const [list, setList] = useState<MailSummary[]>(memo.lists[memo.folder] ?? []);
  const [listErr, setListErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<number | null>(memo.sel);
  const [detail, setDetail] = useState<MailDetail | null>(memo.detail);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [compose, setCompose] = useState<Compose | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (compose) harvestContacts();
  }, [!!compose]);

  const cur = folders.find((f) => f.name === folder);
  const isSent = cur?.role === "sent" || cur?.role === "drafts";

  const folderRef = useRef(folder);
  folderRef.current = folder;

  useEffect(() => {
    memo.cfg = cfg;
    memo.folders = folders;
    memo.folder = folder;
    memo.lists[folder] = list;
    memo.sel = sel;
    memo.detail = detail;
  }, [cfg, folders, folder, list, sel, detail]);

  const loadFolders = useCallback(() => api.mailFolders().then(setFolders).catch(() => undefined), []);

  const loadList = useCallback(
    async (f = folder) => {
      setLoading(true);
      try {
        const ls = await api.mailList(f, 80);
        memo.lists[f] = ls;
        memo.fresh[f] = Date.now();
        if (folderRef.current === f) {
          setList(ls);
          setListErr(null);
        }
        const want = ls.slice(0, 10).map((m) => m.uid);
        if (want.length) api.mailPrefetch(f, want).catch(() => undefined);
      } catch (e) {
        if (folderRef.current === f) setListErr(errText(e));
      } finally {
        if (folderRef.current === f) setLoading(false);
      }
    },
    [folder],
  );

  const showFolder = async (f: string) => {
    if (memo.lists[f]?.length) setList(memo.lists[f]);
    else {
      const c = await api.mailCached(f).catch(() => null);
      if (c && folderRef.current === f) {
        if (c.list.length) setList(c.list);
        if (c.folders.length) setFolders((fs) => (fs.length ? fs : c.folders));
      }
    }
    if (!memo.fresh[f] || Date.now() - memo.fresh[f] > 60000) loadList(f);
  };

  useEffect(() => {
    api.mailConfig().then((c) => {
      setCfg(c);
      if (c.address && c.hasPassword) {
        showFolder(folder);
        if (!memo.fresh.__folders || Date.now() - memo.fresh.__folders > 60000) {
          memo.fresh.__folders = Date.now();
          loadFolders();
        }
      }
    });
  }, []);

  const pickFolder = (f: string) => {
    if (f === folder) return loadList(f);
    folderRef.current = f;
    setFolder(f);
    setSel(null);
    setDetail(null);
    setList([]);
    setLoading(false);
    showFolder(f);
  };

  const open = async (uid: number) => {
    setSel(uid);
    setCompose(null);
    setDetailErr(null);
    const k = dkey(folder, uid);
    const known = memo.details.get(k);
    const unseen = list.some((m) => m.uid === uid && !m.seen);
    if (known) {
      setDetail(known);
      setLoadingDetail(false);
      if (!unseen) return;
    } else setLoadingDetail(true);
    try {
      const d = await api.mailGet(folder, uid);
      memo.details.set(k, d);
      if (memo.details.size > 60) memo.details.delete(memo.details.keys().next().value!);
      setDetail(d);
      setList((ls) => ls.map((m) => (m.uid === uid ? { ...m, seen: true } : m)));
      if (folder === "INBOX") markSeen(uid);
      if (unseen) setFolders((fs) => fs.map((f) => (f.name === folder ? { ...f, unread: Math.max(0, f.unread - 1) } : f)));
    } catch (e) {
      setDetailErr(errText(e));
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  useEffect(() => {
    if (sel == null && list.length && !compose) open(list[0].uid);
  }, [list]);

  const me = (cfg?.address ?? "").toLowerCase();
  const quoteOf = (d: MailDetail) =>
    `\n\n${"-".repeat(20)}\n${when(d.date, now, true)}，${d.fromName || d.fromAddr} 写道：\n` +
    redact(d.text)
      .split("\n")
      .slice(0, 60)
      .map((l) => "> " + l)
      .join("\n");

  const startReply = (kind: "reply" | "all" | "fwd") => {
    if (!detail) return;
    const re = /^re[:：]/i.test(detail.subject) ? detail.subject : "Re: " + detail.subject;
    const others = (xs: string[]) => xs.filter((a) => a.toLowerCase() !== me);
    setCompose({
      kind,
      to: kind === "fwd" ? "" : kind === "all" ? [detail.fromAddr, ...others(detail.to)].filter((v, i, a) => v && a.indexOf(v) === i).join(", ") : detail.fromAddr,
      cc: kind === "all" ? others(detail.cc).join(", ") : "",
      subject: kind === "fwd" ? "Fw: " + detail.subject : re,
      body: "",
      inReplyTo: kind === "fwd" ? null : detail.messageId,
      references: kind === "fwd" ? [] : detail.references,
      quote: quoteOf(detail),
    });
  };

  useEffect(() => {
    if (!mailDraft) return;
    if (mailDraft.reply && !detail && (loadingDetail || list.length)) return;
    if (mailDraft.reply && detail) {
      const re = /^re[:：]/i.test(detail.subject) ? detail.subject : "Re: " + detail.subject;
      setCompose({ kind: "reply", to: detail.fromAddr, cc: mailDraft.cc ?? "", subject: re, body: mailDraft.body, inReplyTo: detail.messageId, references: detail.references, quote: quoteOf(detail) });
    } else {
      setCompose({ ...emptyCompose(), to: mailDraft.to ?? "", cc: mailDraft.cc ?? "", subject: mailDraft.subject ?? "", body: mailDraft.body });
    }
    setMailDraft(null);
  }, [mailDraft, detail, loadingDetail]);

  useFocus(
    () =>
      compose
        ? `正在写邮件：收件人 ${compose.to}，主题 ${compose.subject}，正文：\n${compose.body}`
        : detail
          ? `正在看这封邮件：\n发件人：${detail.fromName} <${detail.fromAddr}>\n收件人：${detail.to.join("、")}\n主题：${detail.subject}\n正文：\n${redact(detail.text).slice(0, 3000)}`
          : `邮箱页「${cur?.label ?? "收件箱"}」，最近邮件：\n${list
              .slice(0, 10)
              .map((m) => `- ${m.fromName || m.fromAddr}：${m.subject}${m.seen ? "" : "（未读）"}`)
              .join("\n")}`,
    [detail, compose, list, cur],
  );

  const send = async () => {
    if (!compose) return;
    const to = splitAddrs(compose.to);
    if (!to.length || !compose.body.trim()) return toast("收件人和正文都要填");
    setSending(true);
    try {
      await api.mailSend({
        to,
        cc: splitAddrs(compose.cc),
        subject: compose.subject,
        body: compose.body + compose.quote,
        inReplyTo: compose.inReplyTo,
        references: compose.references,
      });
      toast("已发送");
      setCompose(null);
      loadFolders();
    } catch (e) {
      toast(errText(e));
    } finally {
      setSending(false);
    }
  };

  const remove = async () => {
    if (!detail) return;
    const uid = detail.uid;
    try {
      await api.mailDelete(folder, uid);
      memo.details.delete(dkey(folder, uid));
      const idx = list.findIndex((m) => m.uid === uid);
      const rest = list.filter((m) => m.uid !== uid);
      setList(rest);
      setDetail(null);
      setSel(null);
      const next = rest[Math.min(idx, rest.length - 1)];
      if (next) open(next.uid);
      loadFolders();
      if (folder === "INBOX") refreshMail();
    } catch (e) {
      toast(errText(e));
    }
  };

  const markUnread = async () => {
    if (!detail) return;
    try {
      await api.mailFlag(folder, detail.uid, "seen", false);
      setList((ls) => ls.map((m) => (m.uid === detail.uid ? { ...m, seen: false } : m)));
      loadFolders();
      if (folder === "INBOX") refreshMail();
    } catch (e) {
      toast(errText(e));
    }
  };

  const saveAtt = async (i: number) => {
    if (!detail) return;
    try {
      const p = await api.mailSaveAttachment(folder, detail.uid, i);
      toast("已存到下载文件夹");
      revealItemInDir(p);
    } catch (e) {
      toast(errText(e));
    }
  };

  if (cfg && (!cfg.address || !cfg.hasPassword)) {
    return (
      <div className="empty-state">
        <h2>还没接入邮箱</h2>
        <button type="button" className="btn solid" onClick={() => go("settings")}>
          去设置
        </button>
      </div>
    );
  }

  const shown = q.trim() ? list.filter((m) => (m.subject + m.fromName + m.fromAddr + m.preview + m.toName).toLowerCase().includes(q.trim().toLowerCase())) : list;

  return (
    <div className="mailapp">
      <aside className="mf">
        <button type="button" className="btn solid wide" onClick={() => setCompose(emptyCompose())}>
          写信
        </button>
        <div className="mf-list">
          {(folders.length ? folders : [{ name: "INBOX", label: "收件箱", role: "inbox", unread: 0, total: 0 }]).map((f) => (
            <button key={f.name} type="button" className={"mf-item" + (folder === f.name ? " on" : "")} onClick={() => pickFolder(f.name)}>
              <span className="mf-ico">{ICON[f.role] ?? "夹"}</span>
              <span className="grow tline">{f.label}</span>
              {f.unread > 0 && f.role !== "sent" && f.role !== "trash" && <span className="mf-count">{f.unread}</span>}
            </button>
          ))}
        </div>
      </aside>

      <section className="ml" aria-label="邮件列表">
        <div className="ml-bar">
          <input className="ml-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" aria-label="搜索邮件" />
          <button
            type="button"
            className={"ml-refresh" + (loading ? " spin" : "")}
            onClick={() => {
              loadList();
              loadFolders();
              if (folder === "INBOX") refreshMail();
            }}
            aria-label="收信"
            disabled={loading}
          >
            ↻
          </button>
        </div>
        {listErr && <div className="ml-err small red">※ {listErr}</div>}
        <div className="ml-rows">
          {shown.map((m) => {
            const name = isSent ? m.toName || "（无收件人）" : m.fromName || m.fromAddr;
            return (
              <button key={m.uid} type="button" className={"ml-row" + (sel === m.uid ? " on" : "") + (m.seen ? "" : " unread")} onClick={() => open(m.uid)}>
                <Avatar name={name} addr={isSent ? "" : m.fromAddr} />
                <span className="ml-main">
                  <span className="ml-top">
                    <span className="ml-from tline">{name}</span>
                    <span className="ml-time">{when(m.date, now)}</span>
                  </span>
                  <span className="ml-subj tline">
                    {m.attach && <span className="ml-att">附</span>}
                    {m.subject || "（无主题）"}
                  </span>
                  <span className="ml-prev tline">{m.preview}</span>
                </span>
              </button>
            );
          })}
          {!loading && !listErr && shown.length === 0 && <div className="ml-empty small ink2">{q ? "没有找到" : "没有邮件"}</div>}
        </div>
      </section>

      <section className="mr" aria-label="阅读">
        {compose ? (
          <div className="mc">
            <div className="mr-bar">
              <span className="mr-title">{compose.kind === "new" ? "写信" : compose.kind === "fwd" ? "转发" : "回复"}</span>
              <span className="grow" />
              <button type="button" className="tb" onClick={() => setCompose(null)}>
                取消
              </button>
              <button type="button" className="btn solid sm" onClick={send} disabled={sending}>
                {sending ? "发送中" : "发送"}
              </button>
            </div>
            <div className="mc-fields">
              <AddrInput label="收件人" value={compose.to} onChange={(to) => setCompose((c) => (c ? { ...c, to } : c))} />
              <AddrInput label="抄送" value={compose.cc} onChange={(cc) => setCompose((c) => (c ? { ...c, cc } : c))} />
              <label className="mc-row">
                <span>主题</span>
                <input value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} />
              </label>
            </div>
            <textarea className="mc-body" value={compose.body} onChange={(e) => setCompose({ ...compose, body: e.target.value })} autoFocus aria-label="正文" />
            {compose.quote && <pre className="mc-quote">{compose.quote.trim()}</pre>}
          </div>
        ) : (
          <>
            <div className="mr-bar">
              <button type="button" className="tb" disabled={!detail} onClick={() => startReply("reply")}>
                回复
              </button>
              <button type="button" className="tb" disabled={!detail} onClick={() => startReply("all")}>
                全部回复
              </button>
              <button type="button" className="tb" disabled={!detail} onClick={() => startReply("fwd")}>
                转发
              </button>
              <span className="tb-sep" />
              <button type="button" className="tb" disabled={!detail} onClick={remove}>
                删除
              </button>
              <button type="button" className="tb" disabled={!detail} onClick={markUnread}>
                标为未读
              </button>
            </div>
            {loadingDetail && <div className="mr-pad small ink2">打开中</div>}
            {detailErr && <div className="mr-pad small red">※ {detailErr}</div>}
            {detail && !loadingDetail && (
              <div className="mr-scroll" key={detail.uid}>
                <h2 className="mr-subject">{detail.subject || "（无主题）"}</h2>
                <div className="mr-head">
                  <Avatar name={detail.fromName} addr={detail.fromAddr} size={42} />
                  <div className="grow min0">
                    <div className="mr-from">
                      <b>{detail.fromName || detail.fromAddr}</b>
                      <span className="ink2"> &lt;{detail.fromAddr}&gt;</span>
                    </div>
                    <div className="mr-to tline">收件人：{detail.toFull.join("、") || "—"}</div>
                    {detail.ccFull.length > 0 && <div className="mr-to tline">抄送：{detail.ccFull.join("、")}</div>}
                  </div>
                  <span className="mr-time">{when(detail.date, now, true)}</span>
                </div>
                {detail.attachments.length > 0 && (
                  <div className="mr-atts">
                    {detail.attachments.map((a, i) => (
                      <button key={i} type="button" className="att-chip" onClick={() => saveAtt(i)} title="存到下载文件夹">
                        <span className="att-ico">{(a.split(".").pop() || "").slice(0, 4).toUpperCase() || "附件"}</span>
                        <span className="tline">{a}</span>
                      </button>
                    ))}
                  </div>
                )}
                <Body detail={detail} />
              </div>
            )}
            {!detail && !loadingDetail && !detailErr && <div className="mr-empty ink2">{profile.name ? "选一封邮件" : ""}</div>}
          </>
        )}
      </section>
    </div>
  );
}
