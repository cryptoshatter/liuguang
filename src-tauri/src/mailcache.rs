use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

const MAX_BODY: usize = 12 * 1024 * 1024;
const KEEP_BODIES: i64 = 400;

fn open(dir: &Path) -> Option<Connection> {
    let c = Connection::open(dir.join("mail-cache.db")).ok()?;
    let _ = c.busy_timeout(std::time::Duration::from_secs(3));
    c.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS summary(acct TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL, validity INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(acct, folder, uid));
         CREATE TABLE IF NOT EXISTS body(acct TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL, raw BLOB NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(acct, folder, uid));
         CREATE TABLE IF NOT EXISTS folders(acct TEXT PRIMARY KEY, data TEXT NOT NULL);",
    )
    .ok()?;
    Some(c)
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn summaries(dir: &Path, acct: &str, folder: &str, validity: Option<i64>) -> Vec<(u32, String)> {
    let Some(c) = open(dir) else { return vec![] };
    if let Some(v) = validity {
        let stale: i64 = c.query_row("SELECT COUNT(*) FROM summary WHERE acct=?1 AND folder=?2 AND validity<>?3", params![acct, folder, v], |r| r.get(0)).unwrap_or(0);
        if stale > 0 {
            let _ = c.execute("DELETE FROM summary WHERE acct=?1 AND folder=?2", params![acct, folder]);
            let _ = c.execute("DELETE FROM body WHERE acct=?1 AND folder=?2", params![acct, folder]);
        }
    }
    let Ok(mut st) = c.prepare("SELECT uid, data FROM summary WHERE acct=?1 AND folder=?2") else { return vec![] };
    st.query_map(params![acct, folder], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?)))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

pub fn replace(dir: &Path, acct: &str, folder: &str, validity: i64, rows: &[(u32, String)]) {
    let Some(mut c) = open(dir) else { return };
    let Ok(tx) = c.transaction() else { return };
    let _ = tx.execute("DELETE FROM summary WHERE acct=?1 AND folder=?2", params![acct, folder]);
    for (uid, data) in rows {
        let _ = tx.execute("INSERT OR REPLACE INTO summary(acct, folder, uid, validity, data) VALUES(?1, ?2, ?3, ?4, ?5)", params![acct, folder, uid, validity, data]);
    }
    let _ = tx.commit();
}

pub fn summary(dir: &Path, acct: &str, folder: &str, uid: u32) -> Option<String> {
    let c = open(dir)?;
    c.query_row("SELECT data FROM summary WHERE acct=?1 AND folder=?2 AND uid=?3", params![acct, folder, uid], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

pub fn put_summary(dir: &Path, acct: &str, folder: &str, uid: u32, data: &str) {
    if let Some(c) = open(dir) {
        let _ = c.execute("UPDATE summary SET data=?4 WHERE acct=?1 AND folder=?2 AND uid=?3", params![acct, folder, uid, data]);
    }
}

pub fn body(dir: &Path, acct: &str, folder: &str, uid: u32) -> Option<Vec<u8>> {
    let c = open(dir)?;
    let r: Option<Vec<u8>> = c
        .query_row("SELECT raw FROM body WHERE acct=?1 AND folder=?2 AND uid=?3", params![acct, folder, uid], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    if r.is_some() {
        let _ = c.execute("UPDATE body SET at=?4 WHERE acct=?1 AND folder=?2 AND uid=?3", params![acct, folder, uid, now()]);
    }
    r
}

pub fn has_body(dir: &Path, acct: &str, folder: &str) -> Vec<u32> {
    let Some(c) = open(dir) else { return vec![] };
    let Ok(mut st) = c.prepare("SELECT uid FROM body WHERE acct=?1 AND folder=?2") else { return vec![] };
    st.query_map(params![acct, folder], |r| r.get::<_, u32>(0)).map(|rows| rows.flatten().collect()).unwrap_or_default()
}

pub fn put_body(dir: &Path, acct: &str, folder: &str, uid: u32, raw: &[u8]) {
    if raw.len() > MAX_BODY {
        return;
    }
    if let Some(c) = open(dir) {
        let _ = c.execute("INSERT OR REPLACE INTO body(acct, folder, uid, raw, at) VALUES(?1, ?2, ?3, ?4, ?5)", params![acct, folder, uid, raw, now()]);
        let _ = c.execute("DELETE FROM body WHERE rowid NOT IN (SELECT rowid FROM body ORDER BY at DESC LIMIT ?1)", params![KEEP_BODIES]);
    }
}

pub fn remove(dir: &Path, acct: &str, folder: &str, uid: u32) {
    if let Some(c) = open(dir) {
        let _ = c.execute("DELETE FROM summary WHERE acct=?1 AND folder=?2 AND uid=?3", params![acct, folder, uid]);
        let _ = c.execute("DELETE FROM body WHERE acct=?1 AND folder=?2 AND uid=?3", params![acct, folder, uid]);
    }
}

pub fn folders(dir: &Path, acct: &str) -> Option<String> {
    let c = open(dir)?;
    c.query_row("SELECT data FROM folders WHERE acct=?1", params![acct], |r| r.get(0)).optional().ok().flatten()
}

pub fn put_folders(dir: &Path, acct: &str, data: &str) {
    if let Some(c) = open(dir) {
        let _ = c.execute("INSERT OR REPLACE INTO folders(acct, data) VALUES(?1, ?2)", params![acct, data]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let d = std::env::temp_dir().join(format!("lgc{}", now()));
        std::fs::create_dir_all(&d).unwrap();
        replace(&d, "a", "INBOX", 7, &[(1, "x".into()), (2, "y".into())]);
        assert_eq!(summaries(&d, "a", "INBOX", Some(7)).len(), 2);
        put_body(&d, "a", "INBOX", 1, b"raw");
        assert_eq!(body(&d, "a", "INBOX", 1).unwrap(), b"raw");
        put_summary(&d, "a", "INBOX", 2, "z");
        assert_eq!(summary(&d, "a", "INBOX", 2).unwrap(), "z");
        assert!(summaries(&d, "a", "INBOX", Some(8)).is_empty());
        assert!(body(&d, "a", "INBOX", 1).is_none());
        std::fs::remove_dir_all(&d).ok();
    }
}
