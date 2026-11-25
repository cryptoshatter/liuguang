import { useState } from "react";
import { useApp } from "../ctx";
import { api, errText, type AgentInfo, type ApiAgent } from "../lib/api";
import { uid } from "../lib/time";
import { Avatar } from "./AgentPanel";

const PRESETS: { name: string; kind: ApiAgent["kind"]; base: string; model: string }[] = [
  { name: "DeepSeek", kind: "openai", base: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { name: "Kimi", kind: "openai", base: "https://api.moonshot.cn/v1", model: "kimi-k2-turbo-preview" },
  { name: "通义千问", kind: "openai", base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { name: "智谱", kind: "openai", base: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6" },
  { name: "OpenAI", kind: "openai", base: "https://api.openai.com/v1", model: "gpt-5" },
  { name: "Anthropic", kind: "anthropic", base: "https://api.anthropic.com", model: "claude-sonnet-4-5" },
];

const blank = (): ApiAgent => ({ id: uid(), name: "", kind: "openai", base: "", model: "", models: [] });

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export default function AgentSettings() {
  const { agents, refreshAgents, settings, setSetting } = useApp();
  const [form, setForm] = useState<ApiAgent | null>(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [paths, setPaths] = useState<Record<string, string>>(() => ({
    claude: settings.claude_path ?? "",
    codex: settings.codex_path ?? "",
    gemini: settings.gemini_path ?? "",
  }));
  const [pathOpen, setPathOpen] = useState<string | null>(null);

  const edit = (a: AgentInfo) => {
    setForm({ id: a.id, name: a.name, kind: a.apiKind ?? "openai", base: a.base ?? "", model: a.model ?? "", models: a.models });
    setModels(a.models);
    setKey("");
    setMsg(null);
  };

  const fresh = (p?: (typeof PRESETS)[number]) => {
    setForm({ ...blank(), ...(p ?? {}) });
    setModels([]);
    setKey("");
    setMsg(null);
  };

  const set = (patch: Partial<ApiAgent>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const test = async () => {
    if (!form) return;
    setTesting(true);
    setMsg(null);
    try {
      const r = await api.agentTest(form, key || null);
      setMsg("连接正常：" + r.trim().slice(0, 40));
    } catch (e) {
      setMsg("※ " + errText(e));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!form) return;
    setMsg(null);
    try {
      await api.agentApiSave({ ...form, name: form.name.trim(), base: form.base.trim(), model: form.model.trim(), models }, key || null);
      setKey("");
      await refreshAgents();
      setMsg("已保存。");
    } catch (e) {
      setMsg("※ " + errText(e));
    }
  };

  const remove = async () => {
    if (!form) return;
    await api.agentApiDelete(form.id);
    await refreshAgents();
    setForm(null);
  };

  const pull = async () => {
    if (!form) return;
    setTesting(true);
    setMsg(null);
    try {
      const list = await api.agentModels(form, key || null);
      setModels(list);
      if (!form.model && list[0]) set({ model: list[0] });
      setMsg(list.length ? `拉到 ${list.length} 个模型。` : "接口没有返回模型列表，直接填模型名即可。");
    } catch (e) {
      setMsg("※ " + errText(e));
    } finally {
      setTesting(false);
    }
  };

  const savePath = async (id: string) => {
    await setSetting(id === "claude" ? "claude_path" : id + "_path", paths[id].trim());
    await refreshAgents();
    setPathOpen(null);
  };

  const exists = form ? agents.some((a) => a.id === form.id) : false;

  return (
    <section className="set-sec">
      <h2>Agent</h2>
      <div className="ag-list">
        {agents.map((a) => (
          <div key={a.id} className="ag-row-wrap">
            <button type="button" className={"ag-row" + (form?.id === a.id || pathOpen === a.id ? " on" : "")} onClick={() => (a.kind === "api" ? edit(a) : setPathOpen(pathOpen === a.id ? null : a.id))}>
              <Avatar who={{ id: a.id, name: a.name, base: a.base }} size="sm" />
              <span className="grow">{a.name}</span>
              <span className={"mono tiny" + (a.found ? " ink2" : " red")}>
                {a.kind === "local" ? (a.found ? "本机 · 已找到" : "本机 · 未找到") : a.hasKey ? "API · " + (a.model || "未选模型") : "API · 缺 Key"}
              </span>
            </button>
            {pathOpen === a.id && (
              <div className="ag-path">
                {a.path && <div className="mono tiny ink2">{a.path}</div>}
                <div className="inline-form">
                  <input value={paths[a.id] ?? ""} onChange={(e) => setPaths((p) => ({ ...p, [a.id]: e.target.value }))} placeholder="路径，留空自动查找" aria-label={a.name + " 路径"} />
                  <button type="button" className="text-btn" onClick={() => savePath(a.id)}>
                    保存并检测
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {!form && (
        <div className="ag-presets">
          {PRESETS.map((p) => (
            <button key={p.name} type="button" className="ag-preset" onClick={() => fresh(p)}>
              <Avatar who={{ id: p.name, name: p.name, base: p.base }} size="sm" />
              {p.name}
            </button>
          ))}
          <button type="button" className="ag-preset" onClick={() => fresh()}>
            ＋ 其他
          </button>
        </div>
      )}

      {form && (
        <div className="ag-form">
          <h3>{exists ? form.name || "API" : "添加 API"}</h3>
          <div className="seg-k" role="radiogroup" aria-label="接口类型">
            {(["openai", "anthropic"] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={form.kind === k} className={form.kind === k ? "on" : ""} onClick={() => set({ kind: k })}>
                {k === "openai" ? "OpenAI 兼容" : "Anthropic"}
              </button>
            ))}
          </div>
          <div className="fields">
            <Field label="名字">
              <input className="line-input" value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="地址">
              <input className="line-input mono" value={form.base} onChange={(e) => set({ base: e.target.value })} placeholder={form.kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"} />
            </Field>
            <Field label="API Key">
              <input className="line-input mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={exists ? "已保存在钥匙串，留空不改" : ""} autoComplete="off" />
            </Field>
            <Field label="模型">
              <div className="ag-model">
                <input className="line-input mono" list={"models-" + form.id} value={form.model} onChange={(e) => set({ model: e.target.value })} />
                <datalist id={"models-" + form.id}>
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <button type="button" className="text-btn" onClick={pull} disabled={testing}>
                  拉取列表
                </button>
              </div>
            </Field>
          </div>
          <div className="row-btns">
            <button type="button" className="btn ghost" onClick={test} disabled={testing}>
              {testing ? "测试中" : "测试"}
            </button>
            <button type="button" className="btn solid" onClick={save} disabled={!form.name.trim()}>
              保存
            </button>
            <button type="button" className="btn ghost" onClick={() => setForm(null)}>
              收起
            </button>
            {exists && (
              <button type="button" className="btn ghost red" onClick={remove}>
                删除
              </button>
            )}
          </div>
          {msg && <div className={"small" + (msg.startsWith("※") ? " red" : " ink2")}>{msg}</div>}
        </div>
      )}
    </section>
  );
}
