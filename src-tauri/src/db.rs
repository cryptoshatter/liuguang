use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::path::{Path, PathBuf};

const MIGRATIONS: &[&str] = &[
    r#"
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        day TEXT,
        title TEXT NOT NULL,
        minutes INTEGER NOT NULL DEFAULT 30,
        start_min INTEGER,
        end_min INTEGER,
        done INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'work',
        done_at TEXT,
        created_at TEXT NOT NULL
    );
    CREATE INDEX tasks_day ON tasks(day);
    CREATE TABLE day_plans (day TEXT PRIMARY KEY, planned_at TEXT NOT NULL);
    CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE INDEX notes_day ON notes(day);
    CREATE TABLE reports (week TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE onboarding (id TEXT PRIMARY KEY, done INTEGER NOT NULL DEFAULT 0, done_at TEXT);
    CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        stage INTEGER NOT NULL,
        title TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        done_at TEXT,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    );
    CREATE TABLE chat (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE INDEX chat_day ON chat(day);
    "#,
];

pub fn now() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

pub fn backup_dir(data: &Path) -> PathBuf {
    data.join("backups")
}

fn vacuum_into(conn: &Connection, target: &Path) -> rusqlite::Result<()> {
    if target.exists() {
        let _ = fs::remove_file(target);
    }
    conn.execute("VACUUM INTO ?1", params![target.to_string_lossy()])?;
    Ok(())
}

pub fn open(data: &Path) -> Result<Connection, String> {
    fs::create_dir_all(backup_dir(data)).map_err(|e| e.to_string())?;
    let path = data.join("liuguang.db");
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
        .map_err(|e| e.to_string())?;
    migrate(&conn, data)?;
    Ok(conn)
}

fn migrate(conn: &Connection, data: &Path) -> Result<(), String> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let target = MIGRATIONS.len() as i64;
    if current > target {
        return Err(format!(
            "数据版本 {} 比应用支持的 {} 新，请安装更新版本的流光",
            current, target
        ));
    }
    if current == target {
        return Ok(());
    }
    if current > 0 {
        let stamp = Local::now().format("%Y%m%d-%H%M%S");
        let file = backup_dir(data).join(format!("pre-migrate-v{}-{}.db", current, stamp));
        vacuum_into(conn, &file).map_err(|e| format!("迁移前备份失败：{}", e))?;
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let v = i as i64 + 1;
        conn.execute_batch(&format!(
            "BEGIN IMMEDIATE;\n{}\nPRAGMA user_version = {};\nCOMMIT;",
            sql, v
        ))
        .map_err(|e| {
            let _ = conn.execute_batch("ROLLBACK;");
            format!("数据迁移到 v{} 失败，已回滚：{}", v, e)
        })?;
    }
    Ok(())
}

pub fn daily_backup(conn: &Connection, data: &Path) -> Result<Option<PathBuf>, String> {
    let dir = backup_dir(data);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("daily-{}.db", Local::now().format("%Y-%m-%d")));
    if file.exists() {
        return Ok(None);
    }
    vacuum_into(conn, &file).map_err(|e| e.to_string())?;
    prune(&dir, "daily-", 30);
    Ok(Some(file))
}

pub fn manual_backup(conn: &Connection, data: &Path) -> Result<PathBuf, String> {
    let dir = backup_dir(data);
    let file = dir.join(format!("manual-{}.db", Local::now().format("%Y%m%d-%H%M%S")));
    vacuum_into(conn, &file).map_err(|e| e.to_string())?;
    prune(&dir, "manual-", 30);
    Ok(file)
}

fn prune(dir: &Path, prefix: &str, keep: usize) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut files: Vec<PathBuf> = rd
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(prefix) && n.ends_with(".db"))
                .unwrap_or(false)
        })
        .collect();
    files.sort();
    while files.len() > keep {
        let f = files.remove(0);
        let _ = fs::remove_file(f);
    }
}

pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_and_reopens() {
        let dir = std::env::temp_dir().join(format!("lg-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        {
            let c = open(&dir).unwrap();
            set_setting(&c, "a", "1").unwrap();
            assert!(daily_backup(&c, &dir).unwrap().is_some());
            assert!(daily_backup(&c, &dir).unwrap().is_none());
        }
        let c = open(&dir).unwrap();
        assert_eq!(get_setting(&c, "a").unwrap().as_deref(), Some("1"));
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
        let _ = fs::remove_dir_all(&dir);
    }
}
