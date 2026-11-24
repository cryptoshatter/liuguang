import { createContext, useContext, useEffect } from "react";
import type { MailSummary } from "./lib/api";
import type { Link, ObItem, Profile, Stage } from "./lib/profile";
import type { TodayApi } from "./today";

export type View = "today" | "cal" | "log" | "onboard" | "mail" | "learn" | "settings";

export type AskOpts = { show?: (raw: string) => string };

export type MailDraft = { reply: boolean; to?: string; cc?: string; subject?: string; body: string };

export type Ctx = {
  now: Date;
  today: string;
  view: View;
  go: (v: View) => void;
  profile: Profile;
  links: Link[];
  obItems: ObItem[];
  stages: Stage[];
  settings: Record<string, string>;
  setSetting: (k: string, v: string) => Promise<void>;
  todayApi: TodayApi;
  ask: (label: string, prompt: string, opts?: AskOpts) => Promise<string | null>;
  say: (text: string, role?: "me" | "ai") => Promise<void>;
  busy: boolean;
  setFocus: (f: (() => string) | null) => void;
  openClaude: () => void;
  mails: MailSummary[];
  mailError: string | null;
  mailLoading: boolean;
  refreshMail: () => Promise<void>;
  markSeen: (uid: number) => void;
  toast: (s: string) => void;
  obState: Record<string, boolean>;
  dataVersion: number;
  bumpData: () => void;
  flash: Set<string>;
  flashIds: (ids: string[]) => void;
  mailDraft: MailDraft | null;
  setMailDraft: (d: MailDraft | null) => void;
};

export const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export function useFocus(fn: (() => string) | null, deps: unknown[]) {
  const { setFocus } = useApp();
  useEffect(() => {
    setFocus(fn);
    return () => setFocus(null);
  }, deps);
}

export const fl = (flash: Set<string>, id: string) => (flash.has(id) ? " flash" : "");
