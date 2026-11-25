import { invoke } from "@tauri-apps/api/core";

export type Task = {
  id: string;
  day: string | null;
  title: string;
  minutes: number;
  start: number | null;
  end: number | null;
  done: boolean;
  pinned: boolean;
  kind: string;
  doneAt: string | null;
};

export type Note = { id: number; day: string; text: string; createdAt: string };
export type Goal = { id: string; stage: number; title: string; done: boolean; doneAt: string | null };
export type ChangeItem = { time?: string; title: string; tag: string };
export type ChangeCard = { view: string; items: ChangeItem[] };
export type ChatMeta = { cards?: ChangeCard[]; suggest?: string[] };
export type ChatMsg = { role: "me" | "ai"; text: string; agent?: string | null; meta?: ChatMeta | null };
export type AgentInfo = {
  id: string;
  name: string;
  kind: "local" | "api";
  found: boolean;
  path: string | null;
  models: string[];
  base: string | null;
  apiKind: "openai" | "anthropic" | null;
  model: string | null;
  hasKey: boolean;
};
export type ApiAgent = { id: string; name: string; kind: "openai" | "anthropic"; base: string; model: string; models: string[] };
export type MailConfig = {
  address: string;
  login: string;
  name: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: string;
  insecure: boolean;
  hasPassword: boolean;
};
export type MailSummary = {
  uid: number;
  fromName: string;
  fromAddr: string;
  toName: string;
  subject: string;
  date: number;
  seen: boolean;
  flagged: boolean;
  attach: boolean;
  preview: string;
};
export type MailFolder = { name: string; label: string; role: string; unread: number; total: number };
export type MailDetail = MailSummary & {
  to: string[];
  cc: string[];
  toFull: string[];
  ccFull: string[];
  text: string;
  html: string | null;
  attachments: string[];
  messageId: string | null;
  references: string[];
};
export type DataInfo = { dataDir: string; backupDir: string; backups: number; lastBackup: string | null };

let agentsP: Promise<AgentInfo[]> | null = null;

export const api = {
  startupError: () => invoke<string | null>("startup_error"),
  dayState: (day: string) => invoke<{ tasks: Task[]; planned: boolean }>("day_state", { day }),
  tasksRange: (from: string, to: string) => invoke<Task[]>("tasks_range", { from, to }),
  tasksBacklog: (day: string) => invoke<Task[]>("tasks_backlog", { day }),
  tasksSave: (tasks: Task[]) => invoke<void>("tasks_save", { tasks }),
  taskDelete: (id: string) => invoke<void>("task_delete", { id }),
  daySetPlanned: (day: string, planned: boolean) => invoke<void>("day_set_planned", { day, planned }),
  notesRange: (from: string, to: string) => invoke<Note[]>("notes_range", { from, to }),
  noteAdd: (day: string, text: string) => invoke<void>("note_add", { day, text }),
  noteDelete: (id: number) => invoke<void>("note_delete", { id }),
  reportGet: (week: string) => invoke<string | null>("report_get", { week }),
  reportSet: (week: string, text: string | null) => invoke<void>("report_set", { week, text }),
  onboardingState: () => invoke<Record<string, boolean>>("onboarding_state"),
  onboardingSet: (id: string, done: boolean) => invoke<void>("onboarding_set", { id, done }),
  goalsList: () => invoke<Goal[]>("goals_list"),
  goalAdd: (id: string, stage: number, title: string) => invoke<void>("goal_add", { id, stage, title }),
  goalSetDone: (id: string, done: boolean) => invoke<void>("goal_set_done", { id, done }),
  goalDelete: (id: string) => invoke<void>("goal_delete", { id }),
  chatList: (day: string) =>
    invoke<(Omit<ChatMsg, "meta"> & { meta: string | null })[]>("chat_list", { day }).then((l) =>
      l.map((m) => {
        let meta: ChatMeta | null = null;
        try {
          meta = m.meta ? JSON.parse(m.meta) : null;
        } catch {}
        return { ...m, meta };
      }),
    ),
  chatAdd: (day: string, m: ChatMsg) =>
    invoke<void>("chat_add", { day, role: m.role, text: m.text, agent: m.agent ?? null, meta: m.meta ? JSON.stringify(m.meta) : null }),
  settingsAll: () => invoke<Record<string, string>>("settings_all"),
  settingSet: (key: string, value: string) => invoke<void>("setting_set", { key, value }),
  dataInfo: () => invoke<DataInfo>("data_info"),
  backupNow: () => invoke<string>("backup_now"),
  exportAll: (markdown: string) => invoke<string>("export_all", { markdown }),
  agents: () => (agentsP ??= invoke<AgentInfo[]>("agents_list")),
  agentsFresh: () => (agentsP = invoke<AgentInfo[]>("agents_list")),
  agentApiSave: (agent: ApiAgent, key: string | null) => invoke<void>("agent_api_save", { agent, key }),
  agentApiDelete: (id: string) => invoke<void>("agent_api_delete", { id }),
  agentModels: (agent: ApiAgent, key: string | null) => invoke<string[]>("agent_models", { agent, key }),
  agentTest: (agent: ApiAgent, key: string | null) => invoke<string>("agent_test", { agent, key }),
  agentAsk: (id: string, model: string, prompt: string) => invoke<string>("agent_ask", { id, model, prompt }),
  mailConfig: () => invoke<MailConfig>("mail_config"),
  mailSaveConfig: (config: MailConfig, password: string | null) => invoke<void>("mail_save_config", { config, password }),
  mailFolders: () => invoke<MailFolder[]>("mail_folders"),
  mailCached: (folder: string) => invoke<{ folders: MailFolder[]; list: MailSummary[] }>("mail_cached", { folder }),
  mailPrefetch: (folder: string, uids: number[]) => invoke<void>("mail_prefetch", { folder, uids }),
  mailList: (folder = "INBOX", limit = 80) => invoke<MailSummary[]>("mail_list", { folder, limit }),
  mailGet: (folder: string, uid: number) => invoke<MailDetail>("mail_get", { folder, uid }),
  mailSaveAttachment: (folder: string, uid: number, index: number) => invoke<string>("mail_save_attachment", { folder, uid, index }),
  mailFlag: (folder: string, uid: number, flag: "seen" | "flagged", on: boolean) => invoke<void>("mail_flag", { folder, uid, flag, on }),
  mailDelete: (folder: string, uid: number) => invoke<void>("mail_delete", { folder, uid }),
  mailSend: (mail: { to: string[]; cc: string[]; subject: string; body: string; inReplyTo: string | null; references: string[] }) =>
    invoke<void>("mail_send", { mail }),
  mailTest: () => invoke<string>("mail_test"),
  mailDetect: () => invoke<{ ok: boolean; summary: string; log: string[]; config: MailConfig }>("mail_detect"),
};

export const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
