use crate::eas::{self, Person};
use crate::{db, mail, mailcache, AppState};
use mail_parser::MessageParser;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Contact {
    pub name: String,
    pub email: String,
    pub dept: String,
}

fn clean_name(name: &str, email: &str) -> String {
    let n = name.trim().trim_matches(['"', '\'']).trim();
    if n.eq_ignore_ascii_case(email) {
        String::new()
    } else {
        n.to_string()
    }
}

pub fn split_mailbox(s: &str) -> Option<(String, String)> {
    let s = s.trim();
    if let (Some(a), Some(b)) = (s.rfind('<'), s.rfind('>')) {
        if a < b {
            let email = s[a + 1..b].trim().to_lowercase();
            let name = clean_name(&s[..a], &email);
            return email.contains('@').then_some((name, email));
        }
    }
    s.contains('@').then(|| (String::new(), s.to_lowercase()))
}

pub fn upsert_dir(c: &Connection, people: &[Person]) {
    for p in people {
        let email = p.email.trim().to_lowercase();
        if !email.contains('@') {
            continue;
        }
        let _ = c.execute(
            "INSERT INTO contacts(email, name, dept, source, updated_at) VALUES(?1, ?2, ?3, 'dir', ?4)
             ON CONFLICT(email) DO UPDATE SET
               name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE contacts.name END,
               dept = excluded.dept, source = 'dir', updated_at = excluded.updated_at",
            params![email, clean_name(&p.name, &email), p.dept.trim(), db::now()],
        );
    }
}

fn upsert_seen(c: &Connection, seen: &HashMap<String, (String, i64)>) {
    for (email, (name, n)) in seen {
        let _ = c.execute(
            "INSERT INTO contacts(email, name, source, seen, updated_at) VALUES(?1, ?2, 'mail', ?3, ?4)
             ON CONFLICT(email) DO UPDATE SET
               name = CASE WHEN contacts.name = '' THEN excluded.name ELSE contacts.name END,
               seen = MAX(contacts.seen, excluded.seen)",
            params![email, name, n, db::now()],
        );
    }
}

pub fn record_sent(c: &Connection, addrs: &[String]) {
    for a in addrs {
        if let Some((name, email)) = split_mailbox(a) {
            let _ = c.execute(
                "INSERT INTO contacts(email, name, source, uses, updated_at) VALUES(?1, ?2, 'mail', 1, ?3)
                 ON CONFLICT(email) DO UPDATE SET
                   name = CASE WHEN contacts.name = '' THEN excluded.name ELSE contacts.name END,
                   uses = contacts.uses + 1",
                params![email, name, db::now()],
            );
        }
    }
}

pub fn search_local(c: &Connection, q: &str, limit: u32) -> Vec<Contact> {
    let q = q.trim().to_lowercase();
    if q.is_empty() {
        return vec![];
    }
    let Ok(mut st) = c.prepare(
        "SELECT name, email, dept FROM contacts
         WHERE instr(lower(name), ?1) > 0 OR instr(email, ?1) > 0
         ORDER BY (instr(lower(name), ?1) = 1 OR instr(email, ?1) = 1) DESC,
                  uses DESC, seen DESC, source = 'dir' DESC, length(name), email
         LIMIT ?2",
    ) else {
        return vec![];
    };
    st.query_map(params![q, limit], |r| Ok(Contact { name: r.get(0)?, email: r.get(1)?, dept: r.get(2)? }))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

fn collect(seen: &mut HashMap<String, (String, i64)>, me: &str, name: &str, email: &str) {
    let email = email.trim().to_lowercase();
    if !email.contains('@') || email == me {
        return;
    }
    let name = clean_name(name, &email);
    let e = seen.entry(email).or_insert((String::new(), 0));
    e.1 += 1;
    if e.0.is_empty() {
        e.0 = name;
    }
}

fn harvest(dir: &std::path::Path, me: &str) -> HashMap<String, (String, i64)> {
    let mut seen = HashMap::new();
    let (summaries, heads) = mailcache::harvest_rows(dir);
    for s in summaries {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            let name = v["fromName"].as_str().unwrap_or("");
            let addr = v["fromAddr"].as_str().unwrap_or("");
            collect(&mut seen, me, name, addr);
        }
    }
    let parser = MessageParser::default();
    for h in heads {
        let h = mail::fix_headers(&h);
        let Some(m) = parser.parse_headers(&h[..]) else { continue };
        for a in [m.to(), m.cc()].into_iter().flatten() {
            for x in a.iter() {
                collect(&mut seen, me, x.name().unwrap_or(""), x.address().unwrap_or(""));
            }
        }
    }
    seen
}

#[tauri::command]
pub fn contacts_search(state: State<'_, AppState>, q: String) -> Result<Vec<Contact>, String> {
    let c = state.conn.lock().map_err(|e| e.to_string())?;
    Ok(search_local(&c, &q, 30))
}

#[tauri::command]
pub async fn contacts_harvest(state: State<'_, AppState>) -> Result<usize, String> {
    let me = mail::own_address(&state).to_lowercase();
    let dir = state.data_dir.clone();
    let seen = tauri::async_runtime::spawn_blocking(move || harvest(&dir, &me)).await.map_err(|e| e.to_string())?;
    let c = state.conn.lock().map_err(|e| e.to_string())?;
    upsert_seen(&c, &seen);
    Ok(seen.len())
}

static DETECTED: Mutex<Option<(String, Option<String>)>> = Mutex::new(None);

fn resolve_host(over: &str, imap_host: &str) -> Option<String> {
    let over = over.trim();
    if !over.is_empty() {
        return Some(over.trim_start_matches("https://").trim_end_matches('/').to_string());
    }
    if let Some((h, r)) = DETECTED.lock().ok().and_then(|g| g.clone()) {
        if h == imap_host {
            return r;
        }
    }
    let r = eas::detect_host(imap_host);
    if let Ok(mut g) = DETECTED.lock() {
        *g = Some((imap_host.to_string(), r.clone()));
    }
    r
}

struct Prep {
    over: String,
    imap_host: String,
    login: String,
    device: String,
}

fn prep(state: &State<'_, AppState>) -> Result<Prep, String> {
    let (login, imap_host) = mail::directory_account(state)?;
    let c = state.conn.lock().map_err(|e| e.to_string())?;
    let over = db::get_setting(&c, "mail_dir_host").ok().flatten().unwrap_or_default();
    let device = match db::get_setting(&c, "eas_device_id").ok().flatten().filter(|d| !d.is_empty()) {
        Some(d) => d,
        None => {
            let d = device_id();
            db::set_setting(&c, "eas_device_id", &d).map_err(|e| e.to_string())?;
            d
        }
    };
    Ok(Prep { over, imap_host, login, device })
}

fn device_id() -> String {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut x = t ^ (std::process::id() as u128) << 64;
    let mut s = String::from("LG");
    for _ in 0..30 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.push(char::from_digit((x % 16) as u32, 16).unwrap().to_ascii_uppercase());
    }
    s
}

fn client(p: Prep) -> Result<eas::Client, String> {
    let host = resolve_host(&p.over, &p.imap_host).ok_or("没找到公司通讯录服务器，可在设置 · 邮箱里填写")?;
    let pass = mail::secret(&p.login)?;
    Ok(eas::Client { host, login: p.login, pass, device: p.device })
}

#[tauri::command]
pub async fn contacts_directory(state: State<'_, AppState>, q: String) -> Result<Vec<Contact>, String> {
    let q = q.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let p = prep(&state)?;
    let people = tauri::async_runtime::spawn_blocking(move || client(p)?.search(&q, 50))
        .await
        .map_err(|e| e.to_string())??;
    let c = state.conn.lock().map_err(|e| e.to_string())?;
    upsert_dir(&c, &people);
    Ok(people
        .into_iter()
        .map(|p| {
            let email = p.email.trim().to_lowercase();
            Contact { name: clean_name(&p.name, &email), email, dept: p.dept }
        })
        .collect())
}

#[tauri::command]
pub async fn contacts_host(state: State<'_, AppState>) -> Result<String, String> {
    let p = prep(&state)?;
    tauri::async_runtime::spawn_blocking(move || resolve_host("", &p.imap_host).unwrap_or_default())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn contacts_test(state: State<'_, AppState>) -> Result<String, String> {
    eas::reset();
    let p = prep(&state)?;
    let q = p.login.split('@').next().unwrap_or("").to_string();
    let (host, people) = tauri::async_runtime::spawn_blocking(move || {
        let c = client(p)?;
        let r = c.search(&q, 5)?;
        Ok::<_, String>((c.host.clone(), r))
    })
    .await
    .map_err(|e| e.to_string())??;
    let c = state.conn.lock().map_err(|e| e.to_string())?;
    upsert_dir(&c, &people);
    Ok(format!("公司通讯录可用（{}）。", host))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let d = std::env::temp_dir().join(format!("lgct{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        db::open(&d).unwrap()
    }

    #[test]
    fn mailbox_parsing() {
        assert_eq!(split_mailbox("张三 <San.Zhang@Example.com>"), Some(("张三".into(), "san.zhang@example.com".into())));
        assert_eq!(split_mailbox("\"李四 (研发)\" <si@x.cn>"), Some(("李四 (研发)".into(), "si@x.cn".into())));
        assert_eq!(split_mailbox("a@b.c"), Some((String::new(), "a@b.c".into())));
        assert_eq!(split_mailbox("张三"), None);
    }

    #[test]
    fn ranking_and_merge() {
        let c = conn();
        upsert_dir(&c, &[
            Person { name: "谭一".into(), email: "yi.tan@example.com".into(), dept: "A部".into() },
            Person { name: "谭二".into(), email: "Er.Tan@example.com".into(), dept: "".into() },
            Person { name: "王谭".into(), email: "tan.wang@example.com".into(), dept: "".into() },
        ]);
        record_sent(&c, &["谭二 <er.tan@example.com>".into()]);
        let mut seen = HashMap::new();
        seen.insert("yi.tan@example.com".to_string(), ("别名".to_string(), 3));
        upsert_seen(&c, &seen);
        let r = search_local(&c, "谭", 10);
        assert_eq!(r.iter().map(|x| x.email.as_str()).collect::<Vec<_>>(), ["er.tan@example.com", "yi.tan@example.com", "tan.wang@example.com"]);
        assert_eq!(r[1].name, "谭一");
        assert_eq!(r[1].dept, "A部");
        assert_eq!(search_local(&c, "TAN.W", 10).len(), 1);
        assert!(search_local(&c, " ", 10).is_empty());
    }
}
