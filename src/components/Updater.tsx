import { useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { errText } from "../lib/api";
import { useApp } from "../ctx";

type State = { kind: "idle" } | { kind: "ready"; update: Update } | { kind: "loading"; pct: number | null } | { kind: "error"; msg: string };

export async function findUpdate() {
  return check({ timeout: 20000 });
}

export default function Updater() {
  const [st, setSt] = useState<State>({ kind: "idle" });
  const { settings } = useApp();
  const auto = useRef(false);
  auto.current = settings.auto_update === "1";
  const installed = useRef<string | null>(null);

  useEffect(() => {
    const run = () =>
      findUpdate()
        .then(async (u) => {
          if (!u || u.version === installed.current) return;
          if (auto.current) {
            await u.downloadAndInstall();
            installed.current = u.version;
          } else setSt((s) => (s.kind === "idle" ? { kind: "ready", update: u } : s));
        })
        .catch(() => undefined);
    const first = window.setTimeout(run, 4000);
    const every = window.setInterval(run, 6 * 3600 * 1000);
    const kick = () => run();
    window.addEventListener("lg-auto-update", kick);
    const manual = (e: Event) => setSt({ kind: "ready", update: (e as CustomEvent<Update>).detail });
    window.addEventListener("lg-update", manual);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
      window.removeEventListener("lg-update", manual);
      window.removeEventListener("lg-auto-update", kick);
    };
  }, []);

  if (st.kind === "idle") return null;

  const install = async (u: Update) => {
    let total = 0;
    let got = 0;
    setSt({ kind: "loading", pct: null });
    try {
      await u.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          setSt({ kind: "loading", pct: total ? Math.round((got / total) * 100) : null });
        }
      });
      await relaunch();
    } catch (e) {
      setSt({ kind: "error", msg: errText(e) });
    }
  };

  return (
    <div className="updater">
      {st.kind === "ready" && (
        <>
          <div className="serif strong">新版本 {st.update.version}</div>
          <div className="row-btns">
            <button type="button" className="btn solid sm" onClick={() => install(st.update)}>
              更新
            </button>
            <button type="button" className="btn ghost sm" onClick={() => setSt({ kind: "idle" })}>
              稍后
            </button>
          </div>
        </>
      )}
      {st.kind === "loading" && <div className="small">更新中{st.pct != null ? ` ${st.pct}%` : "…"}</div>}
      {st.kind === "error" && (
        <>
          <div className="small red">更新失败：{st.msg}</div>
          <button type="button" className="text-btn" onClick={() => setSt({ kind: "idle" })}>
            关闭
          </button>
        </>
      )}
    </div>
  );
}
