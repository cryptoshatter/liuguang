use crate::{db, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tauri::State;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const SERVICE: &str = "流光";
const LOCAL: &[(&str, &str)] = &[("claude", "Claude Code"), ("codex", "Codex"), ("gemini", "Gemini CLI")];

fn local_models(id: &str) -> Vec<String> {
    let v: &[&str] = match id {
        "claude" => &["sonnet", "opus", "haiku"],
        "codex" => &["gpt-5", "gpt-5-codex"],
        "gemini" => &["gemini-2.5-pro", "gemini-2.5-flash"],
        _ => &[],
    };
    v.iter().map(|s| s.to_string()).collect()
}

fn candidates(bin: &str) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(h) = dirs::home_dir() {
        v.push(h.join(".local/bin").join(bin));
        if bin == "claude" {
            v.push(h.join(".claude/local/claude"));
        }
        v.push(h.join(".npm-global/bin").join(bin));
        v.push(h.join(".volta/bin").join(bin));
        v.push(h.join(".bun/bin").join(bin));
    }
    v.push(PathBuf::from("/opt/homebrew/bin").join(bin));
    v.push(PathBuf::from("/usr/local/bin").join(bin));
    v
}

async fn locate(bin: &str, custom: Option<String>) -> Option<String> {
    if let Some(p) = custom.filter(|s| !s.trim().is_empty()) {
        return Some(p.trim().to_string());
    }
    for p in candidates(bin) {
        if p.exists() {
            return Some(p.to_string_lossy().to_string());
        }
    }
    let out = Command::new("/bin/zsh")
        .args(["-lc", &format!("command -v {}", bin)])
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

fn setting(state: &State<'_, AppState>, key: &str) -> Option<String> {
    let c = state.conn.lock().ok()?;
    db::get_setting(&c, key).ok().flatten()
}

fn custom_path(state: &State<'_, AppState>, id: &str) -> Option<String> {
    if id == "claude" {
        setting(state, "claude_path")
    } else {
        setting(state, &format!("{}_path", id))
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiAgent {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub base: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub models: Vec<String>,
}

fn apis(state: &State<'_, AppState>) -> Vec<ApiAgent> {
    setting(state, "agent_apis")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_apis(state: &State<'_, AppState>, list: &[ApiAgent]) -> Result<(), String> {
    let c = state.conn.lock().map_err(|e| e.to_string())?;
    db::set_setting(&c, "agent_apis", &serde_json::to_string(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn key_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &format!("agent:{}", id)).map_err(|e| e.to_string())
}

fn api_key(id: &str) -> Option<String> {
    key_entry(id).ok()?.get_password().ok().filter(|s| !s.is_empty())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    id: String,
    name: String,
    kind: String,
    found: bool,
    path: Option<String>,
    models: Vec<String>,
    base: Option<String>,
    api_kind: Option<String>,
    model: Option<String>,
    has_key: bool,
}

#[tauri::command]
pub async fn agents_list(state: State<'_, AppState>) -> Result<Vec<AgentInfo>, String> {
    let mut out = Vec::new();
    for (id, name) in LOCAL {
        let path = locate(id, custom_path(&state, id)).await;
        out.push(AgentInfo {
            id: id.to_string(),
            name: name.to_string(),
            kind: "local".into(),
            found: path.is_some(),
            path,
            models: local_models(id),
            base: None,
            api_kind: None,
            model: None,
            has_key: false,
        });
    }
    for a in apis(&state) {
        let has_key = api_key(&a.id).is_some();
        out.push(AgentInfo {
            id: a.id.clone(),
            name: a.name.clone(),
            kind: "api".into(),
            found: has_key,
            path: None,
            models: a.models.clone(),
            base: Some(a.base.clone()),
            api_kind: Some(a.kind.clone()),
            model: Some(a.model.clone()),
            has_key,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn agent_api_save(state: State<'_, AppState>, agent: ApiAgent, key: Option<String>) -> Result<(), String> {
    if agent.id.trim().is_empty() || agent.name.trim().is_empty() {
        return Err("名字不能为空".into());
    }
    if let Some(k) = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        key_entry(&agent.id)?.set_password(&k).map_err(|e| format!("写入钥匙串失败：{}", e))?;
    }
    let mut list = apis(&state);
    match list.iter_mut().find(|a| a.id == agent.id) {
        Some(a) => *a = agent,
        None => list.push(agent),
    }
    save_apis(&state, &list)
}

#[tauri::command]
pub fn agent_api_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let list: Vec<ApiAgent> = apis(&state).into_iter().filter(|a| a.id != id).collect();
    if let Ok(e) = key_entry(&id) {
        let _ = e.delete_credential();
    }
    save_apis(&state, &list)
}

fn http() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .try_proxy_from_env(true)
        .timeout_connect(Duration::from_secs(15))
        .timeout(Duration::from_secs(240))
        .build()
}

fn base_of(a: &ApiAgent) -> String {
    let b = a.base.trim().trim_end_matches('/').to_string();
    if b.is_empty() {
        if a.kind == "anthropic" {
            "https://api.anthropic.com".into()
        } else {
            "https://api.openai.com/v1".into()
        }
    } else {
        b
    }
}

fn anthropic_url(base: &str, path: &str) -> String {
    if base.ends_with("/v1") {
        format!("{}/{}", base, path)
    } else {
        format!("{}/v1/{}", base, path)
    }
}

fn http_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| {
                    v.pointer("/error/message")
                        .or_else(|| v.get("message"))
                        .and_then(|m| m.as_str())
                        .map(String::from)
                })
                .unwrap_or_else(|| body.chars().take(300).collect());
            format!("接口返回 {}：{}", code, msg)
        }
        ureq::Error::Transport(t) => format!("连不上接口：{}", t),
    }
}

fn api_call(a: &ApiAgent, key: &str, model: &str, prompt: &str) -> Result<String, String> {
    let base = base_of(a);
    let model = if model.is_empty() { a.model.as_str() } else { model };
    if model.is_empty() {
        return Err("还没选模型".into());
    }
    if a.kind == "anthropic" {
        let v: Value = http()
            .post(&anthropic_url(&base, "messages"))
            .set("x-api-key", key)
            .set("anthropic-version", "2023-06-01")
            .send_json(json!({"model": model, "max_tokens": 4096, "messages": [{"role": "user", "content": prompt}]}))
            .map_err(http_err)?
            .into_json()
            .map_err(|e| e.to_string())?;
        let text = v
            .get("content")
            .and_then(|c| c.as_array())
            .map(|arr| arr.iter().filter_map(|b| b.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join(""))
            .unwrap_or_default();
        Ok(text)
    } else {
        let v: Value = http()
            .post(&format!("{}/chat/completions", base))
            .set("Authorization", &format!("Bearer {}", key))
            .send_json(json!({"model": model, "messages": [{"role": "user", "content": prompt}]}))
            .map_err(http_err)?
            .into_json()
            .map_err(|e| e.to_string())?;
        Ok(v.pointer("/choices/0/message/content").and_then(|t| t.as_str()).unwrap_or("").to_string())
    }
}

fn api_models(a: &ApiAgent, key: &str) -> Result<Vec<String>, String> {
    let base = base_of(a);
    let req = if a.kind == "anthropic" {
        http().get(&anthropic_url(&base, "models")).set("x-api-key", key).set("anthropic-version", "2023-06-01")
    } else {
        http().get(&format!("{}/models", base)).set("Authorization", &format!("Bearer {}", key))
    };
    let v: Value = req.call().map_err(http_err)?.into_json().map_err(|e| e.to_string())?;
    let mut ids: Vec<String> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| arr.iter().filter_map(|m| m.get("id").and_then(|x| x.as_str()).map(String::from)).collect())
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

#[tauri::command]
pub async fn agent_models(state: State<'_, AppState>, agent: ApiAgent, key: Option<String>) -> Result<Vec<String>, String> {
    let key = key
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .or_else(|| api_key(&agent.id))
        .ok_or("先填 API Key")?;
    let a = agent.clone();
    let ids = tokio::task::spawn_blocking(move || api_models(&a, &key)).await.map_err(|e| e.to_string())??;
    let mut list = apis(&state);
    if let Some(x) = list.iter_mut().find(|x| x.id == agent.id) {
        x.models = ids.clone();
        let _ = save_apis(&state, &list);
    }
    Ok(ids)
}

async fn run_cli(bin: &str, script: &str, envs: &[(&str, &str)], stdin: Option<&str>, workdir: &PathBuf) -> Result<(String, String, bool), String> {
    let mut cmd = Command::new("/bin/zsh");
    cmd.args(["-lc", script])
        .env("LG_BIN", bin)
        .current_dir(workdir)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| format!("启动失败：{}", e))?;
    if let (Some(text), Some(mut si)) = (stdin, child.stdin.take()) {
        si.write_all(text.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let out = tokio::time::timeout(Duration::from_secs(240), child.wait_with_output())
        .await
        .map_err(|_| "超过 4 分钟没有回应，已停止。".to_string())?
        .map_err(|e| e.to_string())?;
    Ok((
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).trim().to_string(),
        out.status.success(),
    ))
}

fn cli_err(name: &str, stdout: &str, stderr: &str) -> String {
    let msg = if stderr.is_empty() { stdout.trim() } else { stderr };
    format!("{} 出错：{}", name, msg.chars().take(400).collect::<String>())
}

async fn ask_local(state: &State<'_, AppState>, id: &str, model: &str, prompt: &str) -> Result<String, String> {
    let name = LOCAL.iter().find(|(i, _)| *i == id).map(|(_, n)| *n).unwrap_or(id);
    let bin = locate(id, custom_path(state, id))
        .await
        .ok_or(format!("没有找到本机的 {}。安装后重开流光，或在设置里填写路径。", name))?;
    let workdir = state.data_dir.join("agent");
    let _ = std::fs::create_dir_all(&workdir);
    match id {
        "claude" => {
            let script = if model.is_empty() {
                "exec \"$LG_BIN\" -p --output-format json"
            } else {
                "exec \"$LG_BIN\" -p --output-format json --model \"$LG_MODEL\""
            };
            let (stdout, stderr, ok) = run_cli(&bin, script, &[("LG_MODEL", model)], Some(prompt), &workdir).await?;
            if let Ok(v) = serde_json::from_str::<Value>(stdout.trim()) {
                let text = v.get("result").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if v.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false) {
                    return Err(if text.is_empty() { "Claude 返回了错误".into() } else { text });
                }
                return Ok(text);
            }
            if !ok {
                return Err(cli_err(name, &stdout, &stderr));
            }
            Ok(stdout.trim().to_string())
        }
        "codex" => {
            let last = workdir.join("codex-last.txt");
            let _ = std::fs::remove_file(&last);
            let script = if model.is_empty() {
                "exec \"$LG_BIN\" exec --skip-git-repo-check --sandbox read-only --color never --output-last-message \"$LG_OUT\" -"
            } else {
                "exec \"$LG_BIN\" exec --skip-git-repo-check --sandbox read-only --color never -m \"$LG_MODEL\" --output-last-message \"$LG_OUT\" -"
            };
            let out = last.to_string_lossy().to_string();
            let (stdout, stderr, ok) = run_cli(&bin, script, &[("LG_MODEL", model), ("LG_OUT", &out)], Some(prompt), &workdir).await?;
            if let Ok(t) = std::fs::read_to_string(&last) {
                if !t.trim().is_empty() {
                    return Ok(t.trim().to_string());
                }
            }
            if !ok {
                return Err(cli_err(name, &stdout, &stderr));
            }
            Ok(stdout.trim().to_string())
        }
        _ => {
            let script = if model.is_empty() {
                "exec \"$LG_BIN\" -p \"$LG_PROMPT\""
            } else {
                "exec \"$LG_BIN\" -m \"$LG_MODEL\" -p \"$LG_PROMPT\""
            };
            let (stdout, stderr, ok) = run_cli(&bin, script, &[("LG_MODEL", model), ("LG_PROMPT", prompt)], None, &workdir).await?;
            if !ok {
                return Err(cli_err(name, &stdout, &stderr));
            }
            Ok(stdout.trim().to_string())
        }
    }
}

#[tauri::command]
pub async fn agent_ask(state: State<'_, AppState>, id: String, model: String, prompt: String) -> Result<String, String> {
    if LOCAL.iter().any(|(i, _)| *i == id) {
        return ask_local(&state, &id, &model, &prompt).await;
    }
    let a = apis(&state).into_iter().find(|a| a.id == id).ok_or("这个 Agent 已被删除，请重新选择。")?;
    let key = api_key(&id).ok_or(format!("{} 还没有填 API Key，请到设置里填写。", a.name))?;
    tokio::task::spawn_blocking(move || api_call(&a, &key, &model, &prompt))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_test(agent: ApiAgent, key: Option<String>) -> Result<String, String> {
    let key = key
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .or_else(|| api_key(&agent.id))
        .ok_or("先填 API Key")?;
    tokio::task::spawn_blocking(move || api_call(&agent, &key, "", "回复两个字：可用"))
        .await
        .map_err(|e| e.to_string())?
}
