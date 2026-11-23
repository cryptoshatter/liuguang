use crate::{db, AppState};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tauri::State;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

fn candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(h) = dirs::home_dir() {
        v.push(h.join(".local/bin/claude"));
        v.push(h.join(".claude/local/claude"));
        v.push(h.join(".npm-global/bin/claude"));
        v.push(h.join(".volta/bin/claude"));
    }
    v.push(PathBuf::from("/opt/homebrew/bin/claude"));
    v.push(PathBuf::from("/usr/local/bin/claude"));
    v
}

async fn locate(custom: Option<String>) -> Option<String> {
    if let Some(p) = custom.filter(|s| !s.trim().is_empty()) {
        return Some(p.trim().to_string());
    }
    for p in candidates() {
        if p.exists() {
            return Some(p.to_string_lossy().to_string());
        }
    }
    let out = Command::new("/bin/zsh")
        .args(["-lc", "command -v claude"])
        .stdin(Stdio::null())
        .output()
        .await
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() && s.starts_with('/') {
        Some(s)
    } else {
        None
    }
}

fn custom_path(state: &State<'_, AppState>) -> Option<String> {
    let c = state.conn.lock().ok()?;
    db::get_setting(&c, "claude_path").ok().flatten()
}

#[derive(Serialize)]
pub struct ClaudeStatus {
    found: bool,
    path: Option<String>,
}

#[tauri::command]
pub async fn claude_status(state: State<'_, AppState>) -> Result<ClaudeStatus, String> {
    let path = locate(custom_path(&state)).await;
    Ok(ClaudeStatus { found: path.is_some(), path })
}

#[tauri::command]
pub async fn claude_ask(state: State<'_, AppState>, prompt: String) -> Result<String, String> {
    let bin = locate(custom_path(&state))
        .await
        .ok_or("没有找到本机的 Claude Code。安装后重开流光，或在设置里填写 claude 的路径。")?;
    let workdir = state.data_dir.join("claude");
    let _ = std::fs::create_dir_all(&workdir);
    let mut child = Command::new("/bin/zsh")
        .args([
            "-lc",
            "exec \"$LG_CLAUDE\" -p --output-format json",
        ])
        .env("LG_CLAUDE", &bin)
        .current_dir(&workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("启动 Claude Code 失败：{}", e))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let out = tokio::time::timeout(Duration::from_secs(240), child.wait_with_output())
        .await
        .map_err(|_| "Claude 超过 4 分钟没有回应，已停止。".to_string())?
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        let text = v.get("result").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if v.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false) {
            return Err(if text.is_empty() { "Claude 返回了错误".into() } else { text });
        }
        return Ok(text);
    }
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if err.is_empty() { stdout.trim().to_string() } else { err };
        return Err(format!("Claude Code 出错：{}", msg.chars().take(400).collect::<String>()));
    }
    Ok(stdout.trim().to_string())
}
