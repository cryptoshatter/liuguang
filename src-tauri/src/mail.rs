use crate::{db, AppState};
use lettre::message::header::ContentType;
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{Message, SmtpTransport, Transport};
use mail_parser::{MessageParser, MimeHeaders};
use serde::{Deserialize, Serialize};
use std::net::TcpStream;
use tauri::State;

const SERVICE: &str = "流光";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MailConfig {
    address: String,
    login: String,
    name: String,
    imap_host: String,
    imap_port: u16,
    smtp_host: String,
    smtp_port: u16,
    insecure: bool,
    has_password: bool,
}

fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

fn password(account: &str) -> Result<String, String> {
    keyring_entry(account)?
        .get_password()
        .map_err(|_| "还没有保存邮箱密码，请在设置里填写。".to_string())
}

fn load_config(state: &State<'_, AppState>) -> Result<MailConfig, String> {
    let c = state.conn.lock().map_err(|e| e.to_string())?;
    let g = |k: &str| db::get_setting(&c, k).ok().flatten().unwrap_or_default();
    let address = g("mail_address");
    let login = {
        let l = g("mail_login");
        if l.is_empty() { address.clone() } else { l }
    };
    let host_or = |k: &str| {
        let v = g(k);
        if v.is_empty() { "mail.sunyard.com".to_string() } else { v }
    };
    let port_or = |k: &str, d: u16| g(k).parse::<u16>().unwrap_or(d);
    let has_password = !login.is_empty()
        && keyring_entry(&login).and_then(|e| e.get_password().map_err(|e| e.to_string())).is_ok();
    Ok(MailConfig {
        name: g("mail_name"),
        imap_host: host_or("mail_imap_host"),
        imap_port: port_or("mail_imap_port", 993),
        smtp_host: host_or("mail_smtp_host"),
        smtp_port: port_or("mail_smtp_port", 465),
        insecure: g("mail_insecure") == "1",
        address,
        login,
        has_password,
    })
}

#[tauri::command]
pub fn mail_config(state: State<'_, AppState>) -> Result<MailConfig, String> {
    load_config(&state)
}

#[tauri::command]
pub fn mail_save_config(
    state: State<'_, AppState>,
    config: MailConfig,
    password: Option<String>,
) -> Result<(), String> {
    {
        let c = state.conn.lock().map_err(|e| e.to_string())?;
        let s = |k: &str, v: &str| db::set_setting(&c, k, v).map_err(|e| e.to_string());
        s("mail_address", config.address.trim())?;
        s("mail_login", config.login.trim())?;
        s("mail_name", config.name.trim())?;
        s("mail_imap_host", config.imap_host.trim())?;
        s("mail_imap_port", &config.imap_port.to_string())?;
        s("mail_smtp_host", config.smtp_host.trim())?;
        s("mail_smtp_port", &config.smtp_port.to_string())?;
        s("mail_insecure", if config.insecure { "1" } else { "0" })?;
    }
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        let login = if config.login.trim().is_empty() { config.address.trim() } else { config.login.trim() };
        keyring_entry(login)?.set_password(&p).map_err(|e| format!("写入钥匙串失败：{}", e))?;
    }
    Ok(())
}

type Imap = imap::Session<native_tls::TlsStream<TcpStream>>;

fn connect(cfg: &MailConfig) -> Result<Imap, String> {
    let pass = password(&cfg.login)?;
    let tls = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(cfg.insecure)
        .danger_accept_invalid_hostnames(cfg.insecure)
        .build()
        .map_err(|e| e.to_string())?;
    let client = imap::connect((cfg.imap_host.as_str(), cfg.imap_port), cfg.imap_host.as_str(), &tls)
        .map_err(|e| format!("连不上 {}:{}：{}", cfg.imap_host, cfg.imap_port, e))?;
    let mut s = client
        .login(&cfg.login, &pass)
        .map_err(|(e, _)| format!("邮箱登录失败：{}", e))?;
    let _ = s.run_command_and_check_ok("ID (\"name\" \"liuguang\" \"version\" \"0.1\")");
    Ok(s)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSummary {
    uid: u32,
    from_name: String,
    from_addr: String,
    subject: String,
    date: i64,
    seen: bool,
}

fn first_addr(a: Option<&mail_parser::Address>) -> (String, String) {
    a.and_then(|x| x.first())
        .map(|x| {
            (
                x.name().unwrap_or("").to_string(),
                x.address().unwrap_or("").to_string(),
            )
        })
        .unwrap_or_default()
}

fn list_blocking(cfg: MailConfig, limit: u32) -> Result<Vec<MailSummary>, String> {
    let mut s = connect(&cfg)?;
    let mb = s.select("INBOX").map_err(|e| e.to_string())?;
    if mb.exists == 0 {
        let _ = s.logout();
        return Ok(vec![]);
    }
    let start = mb.exists.saturating_sub(limit.saturating_sub(1)).max(1);
    let fetches = s
        .fetch(format!("{}:{}", start, mb.exists), "(UID FLAGS INTERNALDATE BODY.PEEK[HEADER])")
        .map_err(|e| e.to_string())?;
    let parser = MessageParser::default();
    let mut out = Vec::new();
    for f in fetches.iter() {
        let Some(uid) = f.uid else { continue };
        let seen = f.flags().iter().any(|fl| matches!(fl, imap::types::Flag::Seen));
        let (mut subject, mut from_name, mut from_addr, mut date) =
            (String::new(), String::new(), String::new(), 0i64);
        if let Some(h) = f.header() {
            if let Some(m) = parser.parse_headers(h) {
                subject = m.subject().unwrap_or("").to_string();
                (from_name, from_addr) = first_addr(m.from());
                date = m.date().map(|d| d.to_timestamp()).unwrap_or(0);
            }
        }
        if let Some(d) = f.internal_date() {
            date = d.timestamp();
        }
        out.push(MailSummary { uid, from_name, from_addr, subject, date, seen });
    }
    let _ = s.logout();
    out.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(out)
}

#[tauri::command]
pub async fn mail_list(state: State<'_, AppState>, limit: Option<u32>) -> Result<Vec<MailSummary>, String> {
    let cfg = load_config(&state)?;
    tauri::async_runtime::spawn_blocking(move || list_blocking(cfg, limit.unwrap_or(60)))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDetail {
    uid: u32,
    from_name: String,
    from_addr: String,
    to: Vec<String>,
    cc: Vec<String>,
    subject: String,
    date: i64,
    text: String,
    attachments: Vec<String>,
    message_id: Option<String>,
    references: Vec<String>,
}

fn addrs(a: Option<&mail_parser::Address>) -> Vec<String> {
    a.map(|x| {
        x.iter()
            .filter_map(|y| y.address().map(|s| s.to_string()))
            .collect()
    })
    .unwrap_or_default()
}

fn fetch_raw(cfg: &MailConfig, uid: u32, mark_seen: bool) -> Result<Vec<u8>, String> {
    let mut s = connect(cfg)?;
    s.select("INBOX").map_err(|e| e.to_string())?;
    let fetches = s.uid_fetch(uid.to_string(), "BODY.PEEK[]").map_err(|e| e.to_string())?;
    let raw = fetches
        .iter()
        .find_map(|f| f.body().map(|b| b.to_vec()))
        .ok_or("这封邮件在服务器上已经不存在了")?;
    if mark_seen {
        let _ = s.uid_store(uid.to_string(), "+FLAGS (\\Seen)");
    }
    let _ = s.logout();
    Ok(raw)
}

fn get_blocking(cfg: MailConfig, uid: u32) -> Result<MailDetail, String> {
    let raw = fetch_raw(&cfg, uid, true)?;
    let m = MessageParser::default().parse(&raw).ok_or("邮件解析失败")?;
    let (from_name, from_addr) = first_addr(m.from());
    let references = match m.references() {
        mail_parser::HeaderValue::Text(t) => vec![t.to_string()],
        mail_parser::HeaderValue::TextList(l) => l.iter().map(|x| x.to_string()).collect(),
        _ => vec![],
    };
    Ok(MailDetail {
        uid,
        from_name,
        from_addr,
        to: addrs(m.to()),
        cc: addrs(m.cc()),
        subject: m.subject().unwrap_or("").to_string(),
        date: m.date().map(|d| d.to_timestamp()).unwrap_or(0),
        text: m.body_text(0).map(|t| t.to_string()).unwrap_or_default(),
        attachments: m
            .attachments()
            .enumerate()
            .map(|(i, a)| a.attachment_name().map(|s| s.to_string()).unwrap_or(format!("附件{}", i + 1)))
            .collect(),
        message_id: m.message_id().map(|s| s.to_string()),
        references,
    })
}

#[tauri::command]
pub async fn mail_get(state: State<'_, AppState>, uid: u32) -> Result<MailDetail, String> {
    let cfg = load_config(&state)?;
    tauri::async_runtime::spawn_blocking(move || get_blocking(cfg, uid))
        .await
        .map_err(|e| e.to_string())?
}

fn save_attachment_blocking(cfg: MailConfig, uid: u32, index: usize) -> Result<String, String> {
    let raw = fetch_raw(&cfg, uid, false)?;
    let m = MessageParser::default().parse(&raw).ok_or("邮件解析失败")?;
    let a = m.attachments().nth(index).ok_or("找不到这个附件")?;
    let name = a
        .attachment_name()
        .map(|s| s.replace(['/', '\\', ':'], "_"))
        .unwrap_or(format!("附件{}", index + 1));
    let dir = dirs::download_dir().ok_or("找不到下载文件夹")?;
    let mut path = dir.join(&name);
    let mut n = 1;
    while path.exists() {
        let (stem, ext) = match name.rsplit_once('.') {
            Some((s, e)) => (s.to_string(), format!(".{}", e)),
            None => (name.clone(), String::new()),
        };
        path = dir.join(format!("{} ({}){}", stem, n, ext));
        n += 1;
    }
    std::fs::write(&path, a.contents()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn mail_save_attachment(state: State<'_, AppState>, uid: u32, index: usize) -> Result<String, String> {
    let cfg = load_config(&state)?;
    tauri::async_runtime::spawn_blocking(move || save_attachment_blocking(cfg, uid, index))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outgoing {
    to: Vec<String>,
    cc: Vec<String>,
    subject: String,
    body: String,
    in_reply_to: Option<String>,
    references: Vec<String>,
}

fn sent_folder(s: &mut Imap) -> Option<String> {
    let names = s.list(None, Some("*")).ok()?;
    let mut fallback = None;
    for n in names.iter() {
        let is_sent = n.attributes().iter().any(|a| match a {
            imap::types::NameAttribute::Custom(c) => c.eq_ignore_ascii_case("\\Sent"),
            _ => false,
        });
        if is_sent {
            return Some(n.name().to_string());
        }
        if ["Sent Messages", "Sent", "Sent Items", "&XfJT0ZAB-", "已发送"].contains(&n.name()) {
            fallback = Some(n.name().to_string());
        }
    }
    fallback
}

fn send_blocking(cfg: MailConfig, o: Outgoing) -> Result<(), String> {
    if cfg.address.is_empty() {
        return Err("请先在设置里填写邮箱地址".into());
    }
    let pass = password(&cfg.login)?;
    let from: Mailbox = if cfg.name.is_empty() {
        cfg.address.parse()
    } else {
        format!("{} <{}>", cfg.name, cfg.address).parse()
    }
    .map_err(|e: lettre::address::AddressError| e.to_string())?;
    let mut b = Message::builder().from(from).subject(o.subject.clone());
    for t in o.to.iter().filter(|s| !s.trim().is_empty()) {
        b = b.to(t.trim().parse().map_err(|_| format!("收件人地址不对：{}", t))?);
    }
    for t in o.cc.iter().filter(|s| !s.trim().is_empty()) {
        b = b.cc(t.trim().parse().map_err(|_| format!("抄送地址不对：{}", t))?);
    }
    if let Some(id) = &o.in_reply_to {
        b = b.in_reply_to(id.clone());
    }
    let mut refs = o.references.clone();
    if let Some(id) = &o.in_reply_to {
        if !refs.contains(id) {
            refs.push(id.clone());
        }
    }
    if !refs.is_empty() {
        b = b.references(refs.iter().map(|r| format!("<{}>", r.trim_matches(['<', '>']))).collect::<Vec<_>>().join(" "));
    }
    let email = b
        .header(ContentType::TEXT_PLAIN)
        .body(o.body.clone())
        .map_err(|e| e.to_string())?;
    let tls = TlsParameters::builder(cfg.smtp_host.clone())
        .dangerous_accept_invalid_certs(cfg.insecure)
        .dangerous_accept_invalid_hostnames(cfg.insecure)
        .build()
        .map_err(|e| e.to_string())?;
    let mode = if cfg.smtp_port == 465 { Tls::Wrapper(tls) } else { Tls::Required(tls) };
    let mailer = SmtpTransport::builder_dangerous(cfg.smtp_host.as_str())
        .port(cfg.smtp_port)
        .tls(mode)
        .credentials(Credentials::new(cfg.login.clone(), pass))
        .build();
    mailer.send(&email).map_err(|e| format!("发送失败：{}", e))?;
    if let Ok(mut s) = connect(&cfg) {
        if let Some(folder) = sent_folder(&mut s) {
            let _ = s.append_with_flags(&folder, &email.formatted(), &[imap::types::Flag::Seen]);
        }
        let _ = s.logout();
    }
    Ok(())
}

#[tauri::command]
pub async fn mail_send(state: State<'_, AppState>, mail: Outgoing) -> Result<(), String> {
    let cfg = load_config(&state)?;
    tauri::async_runtime::spawn_blocking(move || send_blocking(cfg, mail))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mail_test(state: State<'_, AppState>) -> Result<u32, String> {
    let cfg = load_config(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = connect(&cfg)?;
        let mb = s.select("INBOX").map_err(|e| e.to_string())?;
        let _ = s.logout();
        Ok(mb.exists)
    })
    .await
    .map_err(|e| e.to_string())?
}
