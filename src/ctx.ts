import { createContext, useContext, useEffect } from "react";
import type { MailSummary } from "./lib/api";
import type { Profile } from "./lib/claude";
import type { TodayApi } from "./today";

export type View = "today" | "cal" | "log" | "onboard" | "mail" | "learn" | "settings";

export type Chip = { label: string; run: () => void };
export type PanelSpec = { chips: Chip[]; context?: () => string };

export type AskOpts = { show?: (raw: string) => string };

export type Ctx = {
  now: Date;
  today: string;
  view: View;
  go: (v: View) => void;
  profile: Profile;
  settings: Record<string, string>;
  setSetting: (k: string, v: string) => Promise<void>;
  todayApi: TodayApi;
  ask: (label: string, prompt: string, opts?: AskOpts) => Promise<string | null>;
  say: (text: string, role?: "me" | "ai") => Promise<void>;
  busy: boolean;
  setPanel: (p: PanelSpec) => void;
  openClaude: () => void;
  mails: MailSummary[];
  mailError: string | null;
  mailLoading: boolean;
  refreshMail: () => Promise<void>;
  markSeen: (uid: number) => void;
  toast: (s: string) => void;
  obVersion: number;
  bumpOb: () => void;
};

export const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export function usePanel(spec: PanelSpec, deps: unknown[]) {
  const { setPanel } = useApp();
  useEffect(() => {
    setPanel(spec);
  }, deps);
}
