use crate::{db, AppState};
use lettre::message::header::ContentType;
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters, TlsVersion};
use lettre::{Message, SmtpTransport, Transport};
use mail_parser::{MessageParser, MimeHeaders};
use serde::{Deserialize, Serialize};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;
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
    imap_security: String,
    smtp_host: String,
    smtp_port: u16,
    smtp_security: String,
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

fn default_security(port: u16, imap: bool) -> String {
    match (imap, port) {
        (true, 993) | (false, 465) => "ssl",
        (true, 143) | (false, 587) | (false, 25) => "starttls",
        _ => "ssl",
    }
    .to_string()
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
    let imap_port = port_or("mail_imap_port", 993);
    let smtp_port = port_or("mail_smtp_port", 465);
    let sec_or = |k: &str, port: u16, imap: bool| {
        let v = g(k);
        if ["ssl", "starttls", "plain"].contains(&v.as_str()) { v } else { default_security(port, imap) }
    };
    let has_password = !login.is_empty()
        && keyring_entry(&login).and_then(|e| e.get_password().map_err(|e| e.to_string())).is_ok();
    Ok(MailConfig {
        name: g("mail_name"),
        imap_host: host_or("mail_imap_host"),
        imap_security: sec_or("mail_imap_security", imap_port, true),
        imap_port,
        smtp_host: host_or("mail_smtp_host"),
        smtp_security: sec_or("mail_smtp_security", smtp_port, false),
        smtp_port,
        insecure: g("mail_insecure") == "1",
        address,
        login,
        has_password,
    })
}

fn save_config(state: &State<'_, AppState>, config: &MailConfig) -> Result<(), String> {
    let c = state.conn.lock().map_err(|e| e.to_string())?;
    let s = |k: &str, v: &str| db::set_setting(&c, k, v).map_err(|e| e.to_string());
    s("mail_address", config.address.trim())?;
    s("mail_login", config.login.trim())?;
    s("mail_name", config.name.trim())?;
    s("mail_imap_host", config.imap_host.trim())?;
    s("mail_imap_port", &config.imap_port.to_string())?;
    s("mail_imap_security", &config.imap_security)?;
    s("mail_smtp_host", config.smtp_host.trim())?;
    s("mail_smtp_port", &config.smtp_port.to_string())?;
    s("mail_smtp_security", &config.smtp_security)?;
    s("mail_insecure", if config.insecure { "1" } else { "0" })?;
    Ok(())
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
    save_config(&state, &config)?;
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        let login = if config.login.trim().is_empty() { config.address.trim() } else { config.login.trim() };
        keyring_entry(login)?.set_password(&p).map_err(|e| format!("写入钥匙串失败：{}", e))?;
    }
    Ok(())
}

pub enum Stream {
    Plain(TcpStream),
    Tls(native_tls::TlsStream<TcpStream>),
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Stream::Plain(s) => s.read(buf),
            Stream::Tls(s) => s.read(buf),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Stream::Plain(s) => s.write(buf),
            Stream::Tls(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Stream::Plain(s) => s.flush(),
            Stream::Tls(s) => s.flush(),
        }
    }
}

type Imap = imap::Session<Stream>;

fn tcp(host: &str, port: u16) -> Result<TcpStream, String> {
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("找不到服务器 {}（{}）。检查服务器地址，或者连上公司网络 / VPN 再试", host, e))?
        .collect();
    let mut last = None;
    for a in addrs {
        match TcpStream::connect_timeout(&a, Duration::from_secs(8)) {
            Ok(s) => {
                let _ = s.set_read_timeout(Some(Duration::from_secs(25)));
                let _ = s.set_write_timeout(Some(Duration::from_secs(25)));
                return Ok(s);
            }
            Err(e) => last = Some(e),
        }
    }
    let e = last.map(|e| e.kind());
    Err(match e {
        Some(ErrorKind::ConnectionRefused) => format!("{}:{} 拒绝连接，这个端口没开", host, port),
        Some(ErrorKind::TimedOut) | Some(ErrorKind::WouldBlock) => {
            format!("连 {}:{} 超时。可能这个端口被挡住了，或者邮箱只能在公司内网 / VPN 下用", host, port)
        }
        _ => format!("连不上 {}:{}", host, port),
    })
}

fn tls_connector(insecure: bool) -> Result<native_tls::TlsConnector, String> {
    native_tls::TlsConnector::builder()
        .min_protocol_version(Some(native_tls::Protocol::Tlsv10))
        .danger_accept_invalid_certs(insecure)
        .danger_accept_invalid_hostnames(insecure)
        .build()
        .map_err(|e| e.to_string())
}

fn tls_wrap(host: &str, port: u16, s: TcpStream, insecure: bool) -> Result<Stream, String> {
    tls_connector(insecure)?
        .connect(host, s)
        .map(Stream::Tls)
        .map_err(|e| format!("能连上 {}:{}，但 SSL 加密握手失败（{}）。这个端口可能不是 SSL，换 STARTTLS 或不加密试试", host, port, e))
}

fn read_line(s: &mut TcpStream) -> Result<String, String> {
    let mut out = Vec::new();
    let mut b = [0u8; 1];
    loop {
        let n = s.read(&mut b).map_err(|e| format!("服务器没有回应：{}", e))?;
        if n == 0 {
            return Err("服务器断开了连接".into());
        }
        out.push(b[0]);
        if b[0] == b'\n' || out.len() > 4096 {
            return Ok(String::from_utf8_lossy(&out).to_string());
        }
    }
}

fn imap_stream(host: &str, port: u16, security: &str, insecure: bool) -> Result<(imap::Client<Stream>, bool), String> {
    let mut s = tcp(host, port)?;
    match security {
        "ssl" => Ok((imap::Client::new(tls_wrap(host, port, s, insecure)?), false)),
        "starttls" => {
            let greet = read_line(&mut s)?;
            if !greet.starts_with("* OK") && !greet.starts_with("* PREAUTH") {
                return Err(format!("{}:{} 不像 IMAP 服务（{}）", host, port, greet.trim()));
            }
            s.write_all(b"lg0 STARTTLS\r\n").map_err(|e| e.to_string())?;
            loop {
                let l = read_line(&mut s)?;
                if l.starts_with("lg0 OK") {
                    break;
                }
                if l.starts_with("lg0 ") {
                    return Err(format!("服务器不支持 STARTTLS（{}）", l.trim()));
                }
            }
            Ok((imap::Client::new(tls_wrap(host, port, s, insecure)?), true))
        }
        _ => Ok((imap::Client::new(Stream::Plain(s)), false)),
    }
}

fn imap_login(host: &str, port: u16, security: &str, insecure: bool, login: &str, pass: &str) -> Result<Imap, String> {
    let (mut client, greeted) = imap_stream(host, port, security, insecure)?;
    if !greeted {
        client
            .read_greeting()
            .map_err(|e| format!("连上了 {}:{}，但没收到 IMAP 欢迎信息（{}）。端口或加密方式可能不对", host, port, e))?;
    }
    let mut s = client.login(login, pass).map_err(|(e, _)| {
        format!("服务器连上了，但登录被拒绝（{}）。检查密码；登录名可以试试 xiao.he 和完整邮箱地址两种", e)
    })?;
    let _ = s.run_command_and_check_ok("ID (\"name\" \"liuguang\" \"version\" \"0.1\")");
    Ok(s)
}

fn connect(cfg: &MailConfig) -> Result<Imap, String> {
    let pass = password(&cfg.login)?;
    imap_login(&cfg.imap_host, cfg.imap_port, &cfg.imap_security, cfg.insecure, &cfg.login, &pass)
}

fn smtp_transport(host: &str, port: u16, security: &str, insecure: bool, login: &str, pass: &str) -> Result<SmtpTransport, String> {
    let params = TlsParameters::builder(host.to_string())
        .set_min_tls_version(TlsVersion::Tlsv10)
        .dangerous_accept_invalid_certs(insecure)
        .dangerous_accept_invalid_hostnames(insecure)
        .build()
        .map_err(|e| e.to_string())?;
    let mode = match security {
        "ssl" => Tls::Wrapper(params),
        "starttls" => Tls::Required(params),
        _ => Tls::None,
    };
    Ok(SmtpTransport::builder_dangerous(host)
        .port(port)
        .tls(mode)
        .timeout(Some(Duration::from_secs(20)))
        .credentials(Credentials::new(login.to_string(), pass.to_string()))
        .build())
}

fn smtp_check(host: &str, port: u16, security: &str, insecure: bool, login: &str, pass: &str) -> Result<(), String> {
    tcp(host, port)?;
    let t = smtp_transport(host, port, security, insecure, login, pass)?;
    match t.test_connection() {
        Ok(true) => Ok(()),
        Ok(false) => Err(format!("{}:{} 没有正常回应 SMTP", host, port)),
        Err(e) => Err(format!("{}:{} SMTP 握手失败（{}）", host, port, e)),
    }
}

fn sec_name(s: &str) -> &'static str {
    match s {
        "ssl" => "SSL",
        "starttls" => "STARTTLS",
        _ => "不加密",
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectResult {
    ok: bool,
    log: Vec<String>,
    config: MailConfig,
}

fn detect_blocking(mut cfg: MailConfig) -> Result<DetectResult, String> {
    let pass = password(&cfg.login)?;
    let domain = cfg.address.split('@').nth(1).unwrap_or("sunyard.com").to_string();
    let mut log = Vec::new();
    let uniq = |v: Vec<String>| {
        let mut out: Vec<String> = Vec::new();
        for x in v {
            if !x.is_empty() && !out.contains(&x) {
                out.push(x);
            }
        }
        out
    };
    let imap_hosts = uniq(vec![cfg.imap_host.clone(), format!("mail.{}", domain), format!("imap.{}", domain)]);
    let smtp_hosts = uniq(vec![cfg.smtp_host.clone(), format!("mail.{}", domain), format!("smtp.{}", domain)]);
    let mut imap_ok = false;
    'imap: for h in &imap_hosts {
        for (port, sec) in [(993u16, "ssl"), (143, "starttls"), (143, "plain")] {
            match imap_login(h, port, sec, cfg.insecure, &cfg.login, &pass) {
                Ok(mut s) => {
                    let _ = s.logout();
                    log.push(format!("✓ 收信 {}:{} {} 登录成功", h, port, sec_name(sec)));
                    cfg.imap_host = h.clone();
                    cfg.imap_port = port;
                    cfg.imap_security = sec.into();
                    imap_ok = true;
                    break 'imap;
                }
                Err(e) => {
                    log.push(format!("✗ 收信 {}:{} {}：{}", h, port, sec_name(sec), e));
                    if e.contains("登录被拒绝") {
                        break 'imap;
                    }
                }
            }
        }
    }
    let mut smtp_ok = false;
    'smtp: for h in &smtp_hosts {
        for (port, sec) in [(465u16, "ssl"), (587, "starttls"), (25, "starttls"), (25, "plain")] {
            match smtp_check(h, port, sec, cfg.insecure, &cfg.login, &pass) {
                Ok(()) => {
                    log.push(format!("✓ 发信 {}:{} {} 可以连通", h, port, sec_name(sec)));
                    cfg.smtp_host = h.clone();
                    cfg.smtp_port = port;
                    cfg.smtp_security = sec.into();
                    smtp_ok = true;
                    break 'smtp;
                }
                Err(e) => log.push(format!("✗ 发信 {}:{} {}：{}", h, port, sec_name(sec), e)),
            }
        }
    }
    Ok(DetectResult { ok: imap_ok && smtp_ok, log, config: cfg })
}

#[tauri::command]
pub async fn mail_detect(state: State<'_, AppState>) -> Result<DetectResult, String> {
    let cfg = load_config(&state)?;
    let r = tauri::async_runtime::spawn_blocking(move || detect_blocking(cfg))
        .await
        .map_err(|e| e.to_string())??;
    if r.log.iter().any(|l| l.starts_with('✓')) {
        save_config(&state, &r.config)?;
    }
    Ok(r)
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
    let mailer = smtp_transport(&cfg.smtp_host, cfg.smtp_port, &cfg.smtp_security, cfg.insecure, &cfg.login, &pass)?;
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
pub async fn mail_test(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = load_config(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = connect(&cfg).map_err(|e| format!("收信：{}", e))?;
        let mb = s.select("INBOX").map_err(|e| format!("收信：打开收件箱失败（{}）", e))?;
        let _ = s.logout();
        let pass = password(&cfg.login)?;
        smtp_check(&cfg.smtp_host, cfg.smtp_port, &cfg.smtp_security, cfg.insecure, &cfg.login, &pass)
            .map_err(|e| format!("收信正常（收件箱 {} 封），但发信不通：{}", mb.exists, e))?;
        Ok(format!("收信和发信都通了，收件箱有 {} 封邮件。", mb.exists))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn fake_server_modes() {
        let mut s = imap_login("127.0.0.1", 14300, "plain", true, "u", "secret").unwrap();
        let _ = s.logout();
        let mut s = imap_login("127.0.0.1", 14300, "starttls", true, "u", "secret").unwrap();
        let _ = s.logout();
        let e = imap_login("127.0.0.1", 14300, "starttls", true, "u", "wrong").err().unwrap();
        assert!(e.contains("登录被拒绝"), "{}", e);
        let e = imap_login("127.0.0.1", 14300, "ssl", true, "u", "secret").err().unwrap();
        assert!(e.contains("SSL"), "{}", e);
        let e = imap_login("127.0.0.1", 14399, "ssl", true, "u", "secret").err().unwrap();
        assert!(e.contains("拒绝连接"), "{}", e);
        println!("{}", e);
    }
}
