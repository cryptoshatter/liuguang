import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/noto-serif-sc/500.css";
import "@fontsource/noto-serif-sc/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";
import App from "./App";
import { api } from "./lib/api";

function Gate() {
  const [state, setState] = useState<"loading" | "ok" | string>("loading");
  useEffect(() => {
    api
      .startupError()
      .then((e) => setState(e ?? "ok"))
      .catch((e) => setState(String(e)));
  }, []);
  if (state === "loading") return null;
  if (state === "ok") return <App />;
  return (
    <div className="fatal">
      <h1>数据没有打开</h1>
      <p>{state}</p>
      <p>为了不损坏数据，流光暂停在这里。原数据和备份都在「应用程序支持/流光」文件夹里，没有被改动。</p>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Gate />
  </React.StrictMode>,
);
