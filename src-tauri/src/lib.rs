mod claude;
mod db;
mod mail;
mod store;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

pub struct AppState {
    pub conn: Mutex<rusqlite::Connection>,
    pub data_dir: PathBuf,
}

fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".liuguang"))
        .join("流光")
}

#[tauri::command]
fn startup_error(state: tauri::State<'_, StartupError>) -> Option<String> {
    state.0.clone()
}

struct StartupError(Option<String>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let dir = data_dir();
    let opened = db::open(&dir);
    let (conn, err) = match opened {
        Ok(c) => (c, None),
        Err(e) => (
            rusqlite::Connection::open_in_memory().expect("memory db"),
            Some(e),
        ),
    };
    let healthy = err.is_none();
    if healthy {
        let _ = db::daily_backup(&conn, &dir);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState { conn: Mutex::new(conn), data_dir: dir })
        .manage(StartupError(err))
        .setup(move |app| {
            if healthy {
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(1800));
                    let state = handle.state::<AppState>();
                    if let Ok(c) = state.conn.lock() {
                        let _ = db::daily_backup(&c, &state.data_dir);
                    };
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_error,
            store::day_state,
            store::tasks_range,
            store::tasks_backlog,
            store::tasks_save,
            store::task_delete,
            store::day_set_planned,
            store::notes_range,
            store::note_add,
            store::note_delete,
            store::report_get,
            store::report_set,
            store::onboarding_state,
            store::onboarding_set,
            store::goals_list,
            store::goal_add,
            store::goal_set_done,
            store::goal_delete,
            store::chat_list,
            store::chat_add,
            store::settings_all,
            store::setting_set,
            store::data_info,
            store::backup_now,
            store::export_all,
            claude::claude_status,
            claude::claude_ask,
            mail::mail_config,
            mail::mail_save_config,
            mail::mail_list,
            mail::mail_get,
            mail::mail_save_attachment,
            mail::mail_send,
            mail::mail_test,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
