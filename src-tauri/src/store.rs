use crate::db::{self, now};
use crate::AppState;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use tauri::State;

type R<T> = Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub day: Option<String>,
    pub title: String,
    pub minutes: i64,
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub done: bool,
    pub pinned: bool,
    pub kind: String,
    pub done_at: Option<String>,
}

const TASK_COLS: &str = "id, day, title, minutes, start_min, end_min, done, pinned, kind, done_at";

fn task_row(r: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        day: r.get(1)?,
        title: r.get(2)?,
        minutes: r.get(3)?,
        start: r.get(4)?,
        end: r.get(5)?,
        done: r.get::<_, i64>(6)? != 0,
        pinned: r.get::<_, i64>(7)? != 0,
        kind: r.get(8)?,
        done_at: r.get(9)?,
    })
}

fn upsert_task(c: &Connection, t: &Task) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO tasks(id, day, title, minutes, start_min, end_min, done, pinned, kind, done_at, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET day = excluded.day, title = excluded.title, minutes = excluded.minutes,
           start_min = excluded.start_min, end_min = excluded.end_min, done = excluded.done,
           pinned = excluded.pinned, kind = excluded.kind, done_at = excluded.done_at",
        params![
            t.id,
            t.day,
            t.title,
            t.minutes,
            t.start,
            t.end,
            t.done as i64,
            t.pinned as i64,
            t.kind,
            t.done_at,
            now()
        ],
    )?;
    Ok(())
}

fn query_tasks(c: &Connection, sql_where: &str, p: &[&dyn rusqlite::ToSql]) -> R<Vec<Task>> {
    let sql = format!(
        "SELECT {} FROM tasks WHERE {} ORDER BY COALESCE(start_min, 99999), created_at",
        TASK_COLS, sql_where
    );
    let mut st = c.prepare(&sql).map_err(e)?;
    let rows = st.query_map(p, task_row).map_err(e)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(e)
}

#[derive(Serialize)]
pub struct DayState {
    tasks: Vec<Task>,
    planned: bool,
}

#[tauri::command]
pub fn day_state(state: State<AppState>, day: String) -> R<DayState> {
    let c = state.conn.lock().map_err(e)?;
    let tasks = query_tasks(&c, "day = ?1", &[&day])?;
    let planned: i64 = c
        .query_row("SELECT COUNT(*) FROM day_plans WHERE day = ?1", params![day], |r| r.get(0))
        .map_err(e)?;
    Ok(DayState { tasks, planned: planned > 0 })
}

#[tauri::command]
pub fn tasks_range(state: State<AppState>, from: String, to: String) -> R<Vec<Task>> {
    let c = state.conn.lock().map_err(e)?;
    query_tasks(&c, "day >= ?1 AND day <= ?2", &[&from, &to])
}

#[tauri::command]
pub fn tasks_backlog(state: State<AppState>, day: String) -> R<Vec<Task>> {
    let c = state.conn.lock().map_err(e)?;
    query_tasks(
        &c,
        "done = 0 AND kind = 'work' AND (day IS NULL OR day < ?1)",
        &[&day],
    )
}

#[tauri::command]
pub fn tasks_save(state: State<AppState>, tasks: Vec<Task>) -> R<()> {
    let mut c = state.conn.lock().map_err(e)?;
    let tx = c.transaction().map_err(e)?;
    for t in &tasks {
        upsert_task(&tx, t).map_err(e)?;
    }
    tx.commit().map_err(e)
}

#[tauri::command]
pub fn task_delete(state: State<AppState>, id: String) -> R<()> {
    let c = state.conn.lock().map_err(e)?;
    c.execute("DELETE FROM tasks WHERE id = ?1", params![id]).map_err(e)?;
    Ok(())
}

#[tauri::command]
pub fn day_set_planned(state: State<AppState>, day: String, planned: bool) -> R<()> {
    let c = state.conn.lock().map_err(e)?;
    if planned {
        c.execute(
            "INSERT OR REPLACE INTO day_plans(day, planned_at) VALUES(?1, ?2)",
            params![day, now()],
        )
        .map_err(e)?;
    } else {
        c.execute("DELETE FROM day_plans WHERE day = ?1", params![day]).map_err(e)?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    id: i64,
    day: String,
    text: String,
    created_at: String,
}

#[tauri::command]
pub fn notes_range(state: State<AppState>, from: String, to: String) -> R<Vec<Note>> {
    let c = state.conn.lock().map_err(e)?;
    let mut st = c
        .prepare("SELECT id, day, text, created_at FROM notes WHERE day >= ?1 AND day <= ?2 ORDER BY day, id")
        .map_err(e)?;
    let rows = st
        .query_map(params![from, to], |r| {
            Ok(Note { id: r.get(0)?, day: r.get(1)?, text: r.get(2)?, created_at: r.get(3)? })
        })
        .map_err(e)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(e)
}

#[tauri::command]
pub fn note_add(state: State<AppState>, day: String, text: String) -> R<()> {
    let c = state.conn.lock().map_err(e)?;
    c.execute(
        "INSERT INTO notes(day, text, created_at) VALUES(?1, ?2, ?3)",
        params![day, text, now()],
    )
    .map_err(e)?;
    Ok(())
}

#[tauri::command]
pub fn note_delete(state: State<AppState>, id: i64) -> R<()> {
    let c = state.conn.lock().map_err(e)?;
    c.execute("DELETE FROM notes WHERE id = ?1", params![id]).map_err(e)?;
    Ok(())
}

#[tauri::command]
pub fn report_get(state: State<AppState>, week: String) -> R<Option<String>> {
    let c = state.conn.lock().map_err(e)?;
    c.query_row("SELECT text FROM reports WHERE week = ?1", params![week], |r| r.get(0))
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(e(other)),
        })
}

#[tauri::command]
pub fn report_set(state: State<AppState>, week: String, text: Option<String>) -> R<()> {
    let c = state.conn.lock().map_err(e)?;
    match text {
        Some(t) => c.execute(
            "INSERT INTO reports(week, text, updated_at) VALUES(?1, ?2, ?3)
             ON CONFLICT(week) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
            params![week, t, now()],
        ),
        None => c.execute("DELETE FROM reports WHERE week = ?1", params![week]),
    }
    .map_err(e)?;
    Ok(())
}

#[tauri::command]
pub fn onboarding_state(state: State<AppState>) -> R<HashMap<String, bool>> {
    let c = state.conn.lock().map_err(e)?;
    let mut st = c.prepare("SELECT id, done FROM onboarding").map_err(e)?;
    let rows = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)))
        .map_err(e)?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>().map_err(e)
}

#[tauri::command]
pub fn onboarding_set(state: State<AppState>, id: String, done: bool) -> R<()> {
    let c = state.conn.lock().map_err(e)?;
    c.execute(
        "INSERT INTO onboarding(id, done, done_at) VALUES(?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET done = excluded.done, done_at = excluded.done_at",
        params![id, done as i64, if done { Some(now()) } else { None }],
    )
    .map_err(e)?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    id: String,
    stage: i64,
    title: String,
    done: bool,
    done_at: Option<String>,
}

#[tauri::command]
pub fn goals_list(state: State<AppState>) -> R<Vec<Goal>> {
    let c = state.conn.lock().map_err(e)?;
    let mut st = c
        .prepare("SELECT id, stage, title, done, done_at FROM goals ORDER BY stage, sort, created_at")
        .map_err(e)?;
    let rows = st
        .query_map([], |r| {
            Ok(Goal {
                id: r.get(0)?,
                stage: r.get(1)?,
                title: r.get(2)?,
                done: r.get::<_, i64>(3)? != 0,
                done_at: r.get(4)?,
            })
        })
        .map_err(e)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(e)
}

#[tauri::command]
pub fn goal_add(state: State<AppState>, id: String, stage: i64, title: String) -> R<()> {
    let c = state.conn.lock().map_err(e)?;
    let sort: i64 = c
        .query_row("SELECT COALESCE(MAX(sort), 0) + 1 FROM goals WHERE stage = ?1", params![stage], |r| r.get(0))
        .map_err(e)?;
    c.execute(
        "INSERT OR IGNORE INTO goals(id, stage, title, sort, created_at) VALUES(?1, ?2, ?3, ?4, ?5)",
        params![id, stage, title, sort, now()],
    )
    .map_err(e)?;
    Ok(())
}

#[tauri::command]
pub fn goal_set_done(state: State<AppState>, id: String, done: bool) -> R<()> {
    let c = state.conn.lock().map_err(e)?;
    c.execute(
        "UPDATE goals SET done = ?2, done_at = ?3 WHERE id = ?1",
        params![id, done as i64, if done { Some(now()) } else { None }],
    )
    .map_err(e)?;
    Ok(())
}

#[tauri::command]
pub fn goal_delete(state: State<AppState>, id: String) -> R<()> {
    let c = state.conn.lock().map_err(e)?;
    c.execute("DELETE FROM goals WHERE id = ?1", params![id]).map_err(e)?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMsg {
    role: String,
    text: String,
}

#[tauri::command]
pub fn chat_list(state: State<AppState>, day: String) -> R<Vec<ChatMsg>> {
    let c = state.conn.lock().map_err(e)?;
    let mut st = c
        .prepare("SELECT role, text FROM (SELECT id, role, text FROM chat WHERE day = ?1 ORDER BY id DESC LIMIT 40) ORDER BY id")
        .map_err(e)?;
    let rows = st
        .query_map(params![day], |r| Ok(ChatMsg { role: r.get(0)?, text: r.get(1)? }))
        .map_err(e)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(e)
}

#[tauri::command]
pub fn chat_add(state: State<AppState>, day: String, role: String, text: String) -> R<()> {
    let c = state.conn.lock().map_err(e)?;
    c.execute(
        "INSERT INTO chat(day, role, text, created_at) VALUES(?1, ?2, ?3, ?4)",
        params![day, role, text, now()],
    )
    .map_err(e)?;
    Ok(())
}

#[tauri::command]
pub fn settings_all(state: State<AppState>) -> R<HashMap<String, String>> {
    let c = state.conn.lock().map_err(e)?;
    let mut st = c.prepare("SELECT key, value FROM settings").map_err(e)?;
    let rows = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(e)?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>().map_err(e)
}

#[tauri::command]
pub fn setting_set(state: State<AppState>, key: String, value: String) -> R<()> {
    let c = state.conn.lock().map_err(e)?;
    db::set_setting(&c, &key, &value).map_err(e)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataInfo {
    data_dir: String,
    backup_dir: String,
    backups: usize,
    last_backup: Option<String>,
}

#[tauri::command]
pub fn data_info(state: State<AppState>) -> R<DataInfo> {
    let dir = db::backup_dir(&state.data_dir);
    let mut names: Vec<String> = fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|x| x.ok())
                .filter_map(|x| x.file_name().to_str().map(|s| s.to_string()))
                .filter(|n| n.ends_with(".db"))
                .collect()
        })
        .unwrap_or_default();
    names.sort_by_key(|n| {
        fs::metadata(dir.join(n)).and_then(|m| m.modified()).ok()
    });
    Ok(DataInfo {
        data_dir: state.data_dir.to_string_lossy().to_string(),
        backup_dir: dir.to_string_lossy().to_string(),
        backups: names.len(),
        last_backup: names.last().cloned(),
    })
}

#[tauri::command]
pub fn backup_now(state: State<AppState>) -> R<String> {
    let c = state.conn.lock().map_err(e)?;
    db::manual_backup(&c, &state.data_dir).map(|p| p.to_string_lossy().to_string())
}

fn table_json(c: &Connection, table: &str) -> R<serde_json::Value> {
    let mut st = c.prepare(&format!("SELECT * FROM {}", table)).map_err(e)?;
    let cols: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
    let rows = st
        .query_map([], |r| {
            let mut m = serde_json::Map::new();
            for (i, name) in cols.iter().enumerate() {
                let v = match r.get_ref(i)? {
                    rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                    rusqlite::types::ValueRef::Integer(n) => serde_json::Value::from(n),
                    rusqlite::types::ValueRef::Real(f) => serde_json::Value::from(f),
                    rusqlite::types::ValueRef::Text(t) => {
                        serde_json::Value::from(String::from_utf8_lossy(t).to_string())
                    }
                    rusqlite::types::ValueRef::Blob(_) => serde_json::Value::Null,
                };
                m.insert(name.clone(), v);
            }
            Ok(serde_json::Value::Object(m))
        })
        .map_err(e)?;
    let list = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?;
    Ok(serde_json::Value::Array(list))
}

#[tauri::command]
pub fn export_all(state: State<AppState>, markdown: String) -> R<String> {
    let c = state.conn.lock().map_err(e)?;
    let base = dirs::document_dir()
        .unwrap_or_else(|| state.data_dir.clone())
        .join("流光导出")
        .join(chrono::Local::now().format("%Y-%m-%d-%H%M%S").to_string());
    fs::create_dir_all(&base).map_err(e)?;
    let mut all = serde_json::Map::new();
    for t in ["tasks", "day_plans", "notes", "reports", "onboarding", "goals", "chat", "settings"] {
        all.insert(t.to_string(), table_json(&c, t)?);
    }
    fs::write(
        base.join("流光数据.json"),
        serde_json::to_string_pretty(&serde_json::Value::Object(all)).map_err(e)?,
    )
    .map_err(e)?;
    fs::write(base.join("工作日志与周报.md"), markdown).map_err(e)?;
    Ok(base.to_string_lossy().to_string())
}
