import type { AgentInfo } from "./api";
import claude from "../assets/agents/claude.svg";
import codex from "../assets/agents/codex.svg";
import gemini from "../assets/agents/gemini.svg";
import deepseek from "../assets/agents/deepseek.svg";
import kimi from "../assets/agents/kimi.svg";
import qwen from "../assets/agents/qwen.svg";
import zhipu from "../assets/agents/zhipu.svg";
import doubao from "../assets/agents/doubao.svg";
import openrouter from "../assets/agents/openrouter.svg";
import openai from "../assets/agents/openai.svg";

const RULES: [RegExp, string][] = [
  [/claude|anthropic/i, claude],
  [/codex/i, codex],
  [/gemini|googleapis/i, gemini],
  [/deepseek/i, deepseek],
  [/kimi|moonshot/i, kimi],
  [/qwen|dashscope|通义|aliyun/i, qwen],
  [/zhipu|bigmodel|glm|智谱/i, zhipu],
  [/doubao|volces|ark\.|豆包/i, doubao],
  [/openrouter/i, openrouter],
  [/openai|gpt/i, openai],
];

export function iconOf(key: string): string | null {
  for (const [re, src] of RULES) if (re.test(key)) return src;
  return null;
}

export type Who = { id: string; name: string; model: string };

export const APP_WHO: Who = { id: "app", name: "流光", model: "" };
export const LEGACY_WHO: Who = { id: "claude", name: "Claude", model: "" };

export const encodeWho = (w: Who) => [w.id, w.name, w.model].join("|");

export function decodeWho(s: string | null | undefined): Who {
  if (!s) return LEGACY_WHO;
  const [id, name, model] = s.split("|");
  return { id: id || "", name: name || id || "", model: model || "" };
}

export const shortName = (a: AgentInfo) => (a.id === "claude" ? "Claude" : a.id === "gemini" ? "Gemini" : a.name);

export const iconFor = (id: string, name: string, base?: string | null) => iconOf(id) ?? iconOf(name) ?? (base ? iconOf(base) : null);
