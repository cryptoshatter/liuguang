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
    let domain = address.split('@').nth(1).unwrap_or("").to_string();
    let host_or = |k: &str| {
        let v = g(k);
        if !v.is_empty() || domain.is_empty() {
            v
        } else if k.contains("imap") {
            format!("imap.{}", domain)
        } else {
            format!("smtp.{}", domain)
        }
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
        .map_err(|e| format!("能连上 {}:{}，但 SSL 加密握手失败（{}）。这个端口可能不是 SSL，换 STARTTLS 或不加密试试；如果现在不在公司网络（比如用手机热点），也可能是公司只对内网开放邮箱，连公司网络再试", host, port, e))
}

fn read_line<R: Read>(s: &mut R) -> Result<String, String> {
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

fn expect_tagged<S: Read>(s: &mut S, tag: &str) -> Result<String, String> {
    loop {
        let l = read_line(s)?;
        if l.starts_with(&format!("{} ", tag)) {
            return Ok(l.trim().to_string());
        }
    }
}

fn imap_stream(host: &str, port: u16, security: &str, insecure: bool) -> Result<imap::Client<Stream>, String> {
    let mut s = tcp(host, port)?;
    let mut stream = match security {
        "ssl" => tls_wrap(host, port, s, insecure)?,
        "starttls" => {
            let greet = read_line(&mut s)?;
            if !greet.starts_with("* OK") && !greet.starts_with("* PREAUTH") {
                return Err(format!("{}:{} 不像 IMAP 服务（{}）", host, port, greet.trim()));
            }
            s.write_all(b"lg0 STARTTLS\r\n").map_err(|e| e.to_string())?;
            let r = expect_tagged(&mut s, "lg0")?;
            if !r.starts_with("lg0 OK") {
                return Err(format!("服务器不支持 STARTTLS（{}）", r));
            }
            tls_wrap(host, port, s, insecure)?
        }
        _ => Stream::Plain(s),
    };
    if security != "starttls" {
        let greet = read_line(&mut stream)
            .map_err(|e| format!("连上了 {}:{}，但没收到 IMAP 欢迎信息（{}）。端口或加密方式可能不对", host, port, e))?;
        if !greet.starts_with("* OK") && !greet.starts_with("* PREAUTH") {
            return Err(format!("{}:{} 不像 IMAP 服务（{}）", host, port, greet.trim()));
        }
    }
    stream
        .write_all(b"lg1 ID (\"name\" \"liuguang\" \"version\" \"0.1\")\r\n")
        .map_err(|e| e.to_string())?;
    expect_tagged(&mut stream, "lg1")?;
    Ok(imap::Client::new(stream))
}

fn imap_login(host: &str, port: u16, security: &str, insecure: bool, login: &str, pass: &str) -> Result<Imap, String> {
    let client = imap_stream(host, port, security, insecure)?;
    client.login(login, pass).map_err(|(e, _)| {
        format!("服务器连上了，但登录被拒绝（{}）", e)
    })
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
        Err(e) if e.to_string().contains("535") => Err(format!("服务器连上了，但登录被拒绝（{}）", e)),
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

fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> tauri::async_runtime::JoinHandle<Result<T, String>> {
    tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_else(|p| {
            let msg = p
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            Err(format!("邮件服务器的回应无法识别（{}）", msg.replace('\n', " ")))
        })
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectResult {
    ok: bool,
    summary: String,
    log: Vec<String>,
    config: MailConfig,
}

fn imap_reach(host: &str, port: u16, sec: &str, insecure: bool) -> Result<(), String> {
    imap_stream(host, port, sec, insecure).map(|_| ())
}

fn smtp_reach(host: &str, port: u16, sec: &str, insecure: bool) -> Result<(), String> {
    tcp(host, port)?;
    let params = TlsParameters::builder(host.to_string())
        .set_min_tls_version(TlsVersion::Tlsv10)
        .dangerous_accept_invalid_certs(insecure)
        .dangerous_accept_invalid_hostnames(insecure)
        .build()
        .map_err(|e| e.to_string())?;
    let mode = match sec {
        "ssl" => Tls::Wrapper(params),
        "starttls" => Tls::Required(params),
        _ => Tls::None,
    };
    let t = SmtpTransport::builder_dangerous(host)
        .port(port)
        .tls(mode)
        .timeout(Some(Duration::from_secs(15)))
        .build();
    match t.test_connection() {
        Ok(true) => Ok(()),
        Ok(false) => Err("没有正常回应 SMTP".into()),
        Err(e) => Err(format!("SMTP 握手失败（{}）", e)),
    }
}

fn detect_blocking(mut cfg: MailConfig) -> Result<DetectResult, String> {
    let pass = password(&cfg.login)?;
    let domain = cfg.address.split('@').nth(1).unwrap_or("").to_string();
    let user = cfg.address.split('@').next().unwrap_or("").to_string();
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
    let imap_hosts = uniq(vec![cfg.imap_host.clone(), format!("imap.{}", domain), format!("mail.{}", domain)]);
    let smtp_hosts = uniq(vec![cfg.smtp_host.clone(), format!("smtp.{}", domain), format!("mail.{}", domain)]);

    let mut imap_found = None;
    'imap: for h in &imap_hosts {
        for (port, sec) in [(993u16, "ssl"), (143, "starttls"), (143, "plain")] {
            match imap_reach(h, port, sec, cfg.insecure) {
                Ok(()) => {
                    log.push(format!("✓ 收信 {}:{} {} 能连通", h, port, sec_name(sec)));
                    imap_found = Some((h.clone(), port, sec));
                    break 'imap;
                }
                Err(e) => log.push(format!("✗ 收信 {}:{} {}：{}", h, port, sec_name(sec), e)),
            }
        }
    }
    let mut smtp_found = None;
    'smtp: for h in &smtp_hosts {
        for (port, sec) in [(465u16, "ssl"), (587, "starttls"), (25, "starttls"), (25, "plain")] {
            match smtp_reach(h, port, sec, cfg.insecure) {
                Ok(()) => {
                    log.push(format!("✓ 发信 {}:{} {} 能连通", h, port, sec_name(sec)));
                    smtp_found = Some((h.clone(), port, sec));
                    break 'smtp;
                }
                Err(e) => log.push(format!("✗ 发信 {}:{} {}：{}", h, port, sec_name(sec), e)),
            }
        }
    }
    if let Some((h, p, sec)) = &imap_found {
        cfg.imap_host = h.clone();
        cfg.imap_port = *p;
        cfg.imap_security = sec.to_string();
    }
    if let Some((h, p, sec)) = &smtp_found {
        cfg.smtp_host = h.clone();
        cfg.smtp_port = *p;
        cfg.smtp_security = sec.to_string();
    }
    if imap_found.is_none() && smtp_found.is_none() {
        return Ok(DetectResult {
            ok: false,
            summary: "收信和发信服务器都连不通。如果现在用的是手机热点或家里网络，可能公司邮箱只对内网开放，连公司网络或 VPN 后再检测一次。".into(),
            log,
            config: cfg,
        });
    }

    let logins = uniq(vec![cfg.login.clone(), cfg.address.clone(), user]);
    let mut imap_login_ok: Option<String> = None;
    let mut last_imap_err = String::new();
    if let Some((h, p, sec)) = &imap_found {
        for l in logins.iter().take(2) {
            match imap_login(h, *p, sec, cfg.insecure, l, &pass) {
                Ok(mut s) => {
                    let _ = s.logout();
                    log.push(format!("✓ 收信用 {} 登录成功", l));
                    imap_login_ok = Some(l.clone());
                    break;
                }
                Err(e) => {
                    log.push(format!("✗ 收信用 {} 登录：{}", l, e));
                    last_imap_err = e;
                }
            }
            std::thread::sleep(Duration::from_millis(800));
        }
    }
    let mut smtp_login_ok: Option<String> = None;
    let mut last_smtp_err = String::new();
    if let Some((h, p, sec)) = &smtp_found {
        let order: Vec<String> = match &imap_login_ok {
            Some(l) => vec![l.clone()],
            None => logins.iter().take(2).cloned().collect(),
        };
        for l in order {
            match smtp_check(h, *p, sec, cfg.insecure, &l, &pass) {
                Ok(()) => {
                    log.push(format!("✓ 发信用 {} 登录成功", l));
                    smtp_login_ok = Some(l);
                    break;
                }
                Err(e) => {
                    log.push(format!("✗ 发信用 {} 登录：{}", l, e));
                    last_smtp_err = e;
                }
            }
            std::thread::sleep(Duration::from_millis(800));
        }
    }
    if let Some(l) = imap_login_ok.clone().or(smtp_login_ok.clone()) {
        if l != cfg.login {
            keyring_entry(&l)?.set_password(&pass).map_err(|e| format!("写入钥匙串失败：{}", e))?;
            cfg.login = l;
        }
    }

    let ok = imap_login_ok.is_some() && smtp_login_ok.is_some();
    let summary = if ok {
        format!("找到了：收信 {}:{}，发信 {}:{}，登录名 {}。已经保存。", cfg.imap_host, cfg.imap_port, cfg.smtp_host, cfg.smtp_port, cfg.login)
    } else if imap_found.is_some() && imap_login_ok.is_none() && (smtp_found.is_none() || smtp_login_ok.is_none()) && !last_imap_err.is_empty() {
        format!(
            "服务器能连上（收信 {}:{}），但登录被拒绝，两种登录名都试过了。最常见的原因：网页邮箱里还没开启 IMAP/SMTP 服务，或者需要单独的客户端授权码；也可能密码已经改过。去网页邮箱「设置」里找「客户端设置 / POP3/IMAP/SMTP」开启，有授权码就把授权码填进密码框。注意别短时间反复检测，服务器会限制登录频率。",
            cfg.imap_host, cfg.imap_port
        )
    } else if imap_found.is_none() {
        "发信服务器能连上，但收信服务器连不通。可能公司只对内网开放 IMAP，连公司网络再试。".into()
    } else if smtp_found.is_none() {
        "收信正常，但发信服务器连不通。可能公司只对内网开放 SMTP，连公司网络再试。".into()
    } else if imap_login_ok.is_some() {
        format!("收信登录成功，但发信登录被拒绝（{}）。可能要在网页邮箱里单独开启 SMTP。", last_smtp_err)
    } else {
        format!("发信登录成功，但收信登录被拒绝（{}）。可能要在网页邮箱里单独开启 IMAP。", last_imap_err)
    };
    Ok(DetectResult { ok, summary, log, config: cfg })
}

#[tauri::command]
pub async fn mail_detect(state: State<'_, AppState>) -> Result<DetectResult, String> {
    let cfg = load_config(&state)?;
    let r = blocking(move || detect_blocking(cfg))
        .await
        .map_err(|e| e.to_string())??;
    save_config(&state, &r.config)?;
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
    blocking(move || list_blocking(cfg, limit.unwrap_or(60)))
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
    blocking(move || get_blocking(cfg, uid))
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
    blocking(move || save_attachment_blocking(cfg, uid, index))
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
    blocking(move || send_blocking(cfg, mail))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn mail_test(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = load_config(&state)?;
    blocking(move || {
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
        s.select("INBOX").ok();
        s.noop().unwrap();
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

#[cfg(test)]
mod charset_tests {
    use mail_parser::MessageParser;
    #[test]
    fn gbk() {
        let raw = b"Subject: =?GB2312?B?suLK1NPKvP4=?=\r\nFrom: =?gbk?B?1cXI/Q==?= <a@b.c>\r\nContent-Type: text/plain; charset=gbk\r\nContent-Transfer-Encoding: base64\r\n\r\nxOO6ww==\r\n";
        let m = MessageParser::default().parse(&raw[..]).unwrap();
        assert_eq!(m.subject(), Some("测试邮件"));
        assert_eq!(m.body_text(0).unwrap(), "你好");
    }
}
