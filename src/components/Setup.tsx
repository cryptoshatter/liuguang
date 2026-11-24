import { useRef, useState } from "react";
import { api, errText } from "../lib/api";
import { importBundle } from "../lib/profile";
import { DEFAULT_HOURS } from "../lib/time";

const pad5 = (v: string) => (/^\d:\d\d$/.test(v) ? "0" + v : v);

export default function Setup({ settings, onDone }: { settings: Record<string, string>; onDone: () => void }) {
  const [f, setF] = useState({
    user_name: settings.user_name ?? "",
    leader_name: settings.leader_name ?? "",
    project_name: settings.project_name ?? "",
    join_date: settings.join_date ?? "",
    work_start: pad5(settings.work_start || DEFAULT_HOURS.work_start),
    lunch_start: pad5(settings.lunch_start || DEFAULT_HOURS.lunch_start),
    lunch_end: pad5(settings.lunch_end || DEFAULT_HOURS.lunch_end),
    work_end: pad5(settings.work_end || DEFAULT_HOURS.work_end),
  });
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const finish = async () => {
    if (!f.user_name.trim()) return setErr("先填名字");
    for (const [k, v] of Object.entries(f)) await api.settingSet(k, v.trim());
    await api.settingSet("setup_done", "1");
    onDone();
  };

  const importFile = async (file: File) => {
    setErr(null);
    try {
      const state = await api.onboardingState();
      await importBundle(await file.text(), (k, v) => api.settingSet(k, v), (id) => api.onboardingSet(id, true), state);
      await api.settingSet("setup_done", "1");
      onDone();
    } catch (e) {
      setErr(errText(e));
    }
  };

  const field = (k: keyof typeof f, label: string, type = "text") => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input className="line-input" type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </label>
  );

  return (
    <div className="setup">
      <div className="dragbar" />
      <div className="setup-card">
        <div className="brand-name">流光</div>
        <h1>先认识一下</h1>
        <div className="fields">
          {field("user_name", "我的名字")}
          {field("leader_name", "周报发给")}
          {field("project_name", "所在项目")}
          {field("join_date", "入职日期", "date")}
        </div>
        <div className="fields four">
          {field("work_start", "上班", "time")}
          {field("lunch_start", "午休开始", "time")}
          {field("lunch_end", "午休结束", "time")}
          {field("work_end", "下班", "time")}
        </div>
        {err && <div className="small red">※ {err}</div>}
        <div className="row-btns">
          <button type="button" className="btn solid" onClick={finish}>
            开始使用
          </button>
          <button type="button" className="btn ghost" onClick={() => fileRef.current?.click()}>
            导入配置文件
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importFile(file);
              e.target.value = "";
            }}
          />
        </div>
      </div>
    </div>
  );
}
