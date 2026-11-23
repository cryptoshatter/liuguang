import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useApp, usePanel } from "../ctx";
import { api, errText, type MailConfig, type MailDetail } from "../lib/api";
import { redact } from "../lib/claude";
import { dayKey, pad } from "../lib/time";

const when = (ts: number, now: Date) => {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
  if (dayKey(d) === dayKey(now)) return "今天 " + hm;
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(d) === dayKey(y)) return "昨天 " + hm;
  return (d.getFullYear() !== now.getFullYear() ? d.getFullYear() + "/" : "") + (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
};

type Compose = { to: string; cc: string; subject: string; body: string; inReplyTo: string | null; references: string[] };

const emptyCompose = (): Compose => ({ to: "", cc: "", subject: "", body: "", inReplyTo: null, references: [] });

const splitAddrs = (s: string) => s.split(/[,，;；\s]+/).filter(Boolean);

export default function Mail() {
  const { now, mails, mailError, mailLoading, refreshMail, markSeen, go, ask, toast, profile } = useApp();
  const [cfg, setCfg] = useState<MailConfig | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState<MailDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [mode, setMode] = useState<"reply" | "new">("reply");
  const [compose, setCompose] = useState<Compose>(emptyCompose);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api.mailConfig().then(setCfg);
  }, []);

  useEffect(() => {
    if (sel == null && mails.length) open(mails[0].uid);
  }, [mails]);

  const open = async (uid: number) => {
    setSel(uid);
    setMode("reply");
    setLoadingDetail(true);
    setDetailErr(null);
    try {
      const d = await api.mailGet(uid);
      setDetail(d);
      markSeen(uid);
      setCompose({
        to: d.fromAddr,
        cc: "",
        subject: /^re[:：]/i.test(d.subject) ? d.subject : "Re: " + d.subject,
        body: "",
        inReplyTo: d.messageId,
        references: d.references,
      });
    } catch (e) {
      setDetailErr(errText(e));
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const quoted = (d: MailDetail) =>
    `\n\n${"-".repeat(20)}\n${when(d.date, now)}，${d.fromName || d.fromAddr} 写道：\n` + redact(d.text).split("\n").slice(0, 40).map((l) => "> " + l).join("\n");

  const draftReply = async () => {
    if (!detail) return;
    const raw = await ask(
      "帮我回复这封邮件",
      `帮我起草一封回信，语气正式简短，署名${profile.name}。只输出正文，放在一个 text 代码块里。\n\n原邮件\n发件人：${detail.fromName} <${detail.fromAddr}>\n主题：${detail.subject}\n正文：\n${redact(detail.text).slice(0, 4000)}`,
      { show: () => "草稿已放进回复框。" },
    );
    if (!raw) return;
    const m = raw.match(/```(?:text)?\s*([\s\S]*?)```/);
    setMode("reply");
    setCompose((c) => ({ ...c, body: (m ? m[1] : raw).trim() }));
  };

  usePanel(
    {
      chips: detail ? [{ label: "帮我回复这封邮件", run: draftReply }] : [],
      context: () => (detail ? `我正在看这封邮件：\n发件人：${detail.fromName} <${detail.fromAddr}>\n主题：${detail.subject}\n正文：\n${redact(detail.text).slice(0, 3000)}` : ""),
    },
    [detail],
  );

  const send = async () => {
    const to = splitAddrs(compose.to);
    if (!to.length || !compose.body.trim()) return toast("收件人和正文都要填");
    setSending(true);
    try {
      const body = mode === "reply" && detail ? compose.body + quoted(detail) : compose.body;
      await api.mailSend({
        to,
        cc: splitAddrs(compose.cc),
        subject: compose.subject,
        body,
        inReplyTo: mode === "reply" ? compose.inReplyTo : null,
        references: mode === "reply" ? compose.references : [],
      });
      toast("已发送");
      if (mode === "new") setCompose(emptyCompose());
      else setCompose((c) => ({ ...c, body: "" }));
    } catch (e) {
      toast(errText(e));
    } finally {
      setSending(false);
    }
  };

  const saveAtt = async (i: number) => {
    if (!detail) return;
    try {
      const p = await api.mailSaveAttachment(detail.uid, i);
      toast("已存到下载文件夹");
      revealItemInDir(p);
    } catch (e) {
      toast(errText(e));
    }
  };

  if (cfg && (!cfg.address || !cfg.hasPassword)) {
    return (
      <div className="empty-state">
        <h2>还没接入公司邮箱</h2>
        <p className="small ink2">填好邮箱地址和密码就能在这里收发邮件，密码只存在钥匙串里。</p>
        <button type="button" className="btn solid" onClick={() => go("settings")}>
          去设置
        </button>
      </div>
    );
  }

  const smart = detail && /入职/.test(detail.subject);

  return (
    <div className="cols">
      <section className="col-list" aria-label="收件箱">
        <div className="sec-head">
          <div className="row-btns">
            <button type="button" className="btn ghost sm" onClick={refreshMail} disabled={mailLoading}>
              {mailLoading ? "收取中" : "收信"}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setMode("new");
                setCompose(emptyCompose());
              }}
            >
              写信
            </button>
          </div>
          <span className="mono tiny ink2">{mails.length} 封</span>
        </div>
        {mailError && <div className="small red pad-y">※ {mailError}</div>}
        <div className="rule-top">
          {mails.map((m) => (
            <button key={m.uid} type="button" className={"mail-row" + (sel === m.uid ? " on" : "")} onClick={() => open(m.uid)}>
              <span className="kv">
                <span className={"mail-from" + (m.seen ? "" : " unread")}>{m.fromName || m.fromAddr}</span>
                <span className="mono tiny ink2 nowrap">{when(m.date, now)}</span>
              </span>
              <span className="tline small dblock">{m.subject || "（无主题）"}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="col-read" aria-label="阅读">
        {mode === "reply" && loadingDetail && <div className="small ink2">打开中</div>}
        {mode === "reply" && detailErr && <div className="small red">※ {detailErr}</div>}
        {mode === "reply" && detail && !loadingDetail && (
          <>
            <div>
              <h2 className="mail-subject">{detail.subject || "（无主题）"}</h2>
              <div className="mono small ink2 mt8">
                {detail.fromName} &lt;{detail.fromAddr}&gt; · {when(detail.date, now)}
              </div>
            </div>
            {smart && (
              <div className="small red">
                ※ 入职相关邮件，事项已整理进{" "}
                <button type="button" className="text-btn red" onClick={() => go("onboard")}>
                  入职清单 →
                </button>
              </div>
            )}
            <div className="mail-body">{redact(detail.text)}</div>
            {detail.attachments.length > 0 && (
              <div className="mono small ink2">
                <div>附件</div>
                {detail.attachments.map((a, i) => (
                  <button key={i} type="button" className="att" onClick={() => saveAtt(i)}>
                    — {a}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {(mode === "new" || detail) && (
          <div className="compose">
            {mode === "new" ? (
              <>
                <input className="line-input" value={compose.to} onChange={(e) => setCompose({ ...compose, to: e.target.value })} placeholder="收件人" aria-label="收件人" />
                <input className="line-input" value={compose.cc} onChange={(e) => setCompose({ ...compose, cc: e.target.value })} placeholder="抄送" aria-label="抄送" />
                <input className="line-input" value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} placeholder="主题" aria-label="主题" />
              </>
            ) : (
              <label className="mono tiny ink2" htmlFor="reply">
                回复 {detail?.fromName || detail?.fromAddr}
              </label>
            )}
            <textarea id="reply" className="ruled" rows={6} value={compose.body} onChange={(e) => setCompose({ ...compose, body: e.target.value })} />
            <div className="row-btns">
              <button type="button" className="btn solid" onClick={send} disabled={sending}>
                {sending ? "发送中" : "发送"}
              </button>
              {mode === "reply" && (
                <button type="button" className="btn ghost" onClick={draftReply}>
                  Claude 起草
                </button>
              )}
              {mode === "new" && detail && (
                <button type="button" className="btn ghost" onClick={() => setMode("reply")}>
                  取消
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
