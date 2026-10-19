/**
 * pi/omp 供应商认证 UI catalog.
 *
 * Ported from the reference desktop-cc-gui's piAuthProviderCatalog.ts:
 * - `id` matches the backend `pi_family_auth.rs` catalog (pi: auth.json entry
 *   key; omp: `auth_credentials.provider`), aligned with pi v0.84.3's env map
 *   (omp forked the same provider registry).
 * - Brand icons come from `@lobehub/icons-static-svg`; providers without a
 *   public logo return null and the caller falls back to a Globe icon — no
 *   letter tiles impersonating a brand.
 * - featured=true are shown by default; the rest fold into "show all".
 *
 * OAuth groups differ per engine: pi's `/login <arg>` TUI command takes pi
 * provider ids, omp's `omp auth-broker login <id>` takes omp's own (longer)
 * OAuth provider list. `statusIds` name the credential-store ids that count
 * as "authorized" for the row (pi's ChatGPT subscription lands on disk as
 * `openai-codex`).
 */
import anthropicIcon from "@lobehub/icons-static-svg/icons/anthropic.svg";
import azureaiIcon from "@lobehub/icons-static-svg/icons/azureai-color.svg";
import basetenIcon from "@lobehub/icons-static-svg/icons/baseten.svg";
import bedrockIcon from "@lobehub/icons-static-svg/icons/bedrock-color.svg";
import cerebrasIcon from "@lobehub/icons-static-svg/icons/cerebras-color.svg";
import claudeIcon from "@lobehub/icons-static-svg/icons/claude-color.svg";
import cloudflareIcon from "@lobehub/icons-static-svg/icons/cloudflare-color.svg";
import copilotIcon from "@lobehub/icons-static-svg/icons/copilot-color.svg";
import deepseekIcon from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import fireworksIcon from "@lobehub/icons-static-svg/icons/fireworks-color.svg";
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import groqIcon from "@lobehub/icons-static-svg/icons/groq.svg";
import huggingfaceIcon from "@lobehub/icons-static-svg/icons/huggingface-color.svg";
import kimiIcon from "@lobehub/icons-static-svg/icons/kimi-color.svg";
import minimaxIcon from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import mistralIcon from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import nvidiaIcon from "@lobehub/icons-static-svg/icons/nvidia-color.svg";
import openaiIcon from "@lobehub/icons-static-svg/icons/openai.svg";
import opencodeIcon from "@lobehub/icons-static-svg/icons/opencode.svg";
import openrouterIcon from "@lobehub/icons-static-svg/icons/openrouter-color.svg";
import qwenIcon from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import togetherIcon from "@lobehub/icons-static-svg/icons/together-color.svg";
import vercelIcon from "@lobehub/icons-static-svg/icons/vercel.svg";
import xaiIcon from "@lobehub/icons-static-svg/icons/xai.svg";
import xiaomimimoIcon from "@lobehub/icons-static-svg/icons/xiaomimimo.svg";
import zhipuIcon from "@lobehub/icons-static-svg/icons/zhipu-color.svg";

export interface PiFamilyAuthUiProvider {
  /** Credential-store entry key (backend catalog id). */
  id: string;
  /** Brand display name (not translated). */
  name: string;
  /** Brand icon asset; null = caller falls back to Globe. */
  iconSrc: string | null;
  /** Shown by default (true) or folded into "show all" (false). */
  featured: boolean;
}

/** API Key group: 36 entries (github-copilot is OAuth-only and not listed;
 * the moonshotai dual-region pair follows pi 0.84.x's env map). */
export const PI_FAMILY_APIKEY_PROVIDERS: readonly PiFamilyAuthUiProvider[] = [
  { id: "anthropic", name: "Anthropic", iconSrc: anthropicIcon, featured: true },
  { id: "openai", name: "OpenAI", iconSrc: openaiIcon, featured: true },
  { id: "google", name: "Google Gemini", iconSrc: geminiIcon, featured: true },
  { id: "deepseek", name: "DeepSeek", iconSrc: deepseekIcon, featured: true },
  { id: "xai", name: "xAI", iconSrc: xaiIcon, featured: true },
  { id: "openrouter", name: "OpenRouter", iconSrc: openrouterIcon, featured: true },
  { id: "groq", name: "Groq", iconSrc: groqIcon, featured: true },
  { id: "mistral", name: "Mistral", iconSrc: mistralIcon, featured: true },
  { id: "zai", name: "ZAI Coding Plan", iconSrc: zhipuIcon, featured: true },
  { id: "kimi-coding", name: "Kimi For Coding", iconSrc: kimiIcon, featured: true },
  { id: "moonshotai", name: "Moonshot AI", iconSrc: null, featured: false },
  { id: "moonshotai-cn", name: "Moonshot AI (China)", iconSrc: null, featured: false },
  { id: "qwen-token-plan", name: "Qwen Token Plan", iconSrc: qwenIcon, featured: true },
  { id: "minimax", name: "MiniMax", iconSrc: minimaxIcon, featured: true },
  { id: "together", name: "Together AI", iconSrc: togetherIcon, featured: true },
  { id: "fireworks", name: "Fireworks", iconSrc: fireworksIcon, featured: true },
  { id: "cerebras", name: "Cerebras", iconSrc: cerebrasIcon, featured: true },
  { id: "amazon-bedrock", name: "Amazon Bedrock", iconSrc: bedrockIcon, featured: true },
  { id: "ant-ling", name: "Ant Ling", iconSrc: null, featured: false },
  { id: "azure-openai-responses", name: "Azure OpenAI Responses", iconSrc: azureaiIcon, featured: false },
  { id: "nvidia", name: "NVIDIA NIM", iconSrc: nvidiaIcon, featured: false },
  { id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway", iconSrc: cloudflareIcon, featured: false },
  { id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", iconSrc: cloudflareIcon, featured: false },
  { id: "vercel-ai-gateway", name: "Vercel AI Gateway", iconSrc: vercelIcon, featured: false },
  { id: "zai-coding-cn", name: "ZAI Coding Plan (China)", iconSrc: zhipuIcon, featured: false },
  { id: "opencode", name: "OpenCode Zen", iconSrc: opencodeIcon, featured: false },
  { id: "opencode-go", name: "OpenCode Go", iconSrc: opencodeIcon, featured: false },
  { id: "radius", name: "Radius", iconSrc: null, featured: false },
  { id: "huggingface", name: "Hugging Face", iconSrc: huggingfaceIcon, featured: false },
  { id: "baseten", name: "Baseten", iconSrc: basetenIcon, featured: false },
  { id: "minimax-cn", name: "MiniMax (China)", iconSrc: minimaxIcon, featured: false },
  { id: "qwen-token-plan-individual", name: "Qwen Token Plan (Individual)", iconSrc: qwenIcon, featured: false },
  { id: "qwen-token-plan-cn", name: "Qwen Token Plan (China)", iconSrc: qwenIcon, featured: false },
  { id: "xiaomi", name: "Xiaomi MiMo", iconSrc: xiaomimimoIcon, featured: false },
  { id: "xiaomi-token-plan-cn", name: "Xiaomi MiMo Token Plan (China)", iconSrc: xiaomimimoIcon, featured: false },
  { id: "xiaomi-token-plan-ams", name: "Xiaomi MiMo Token Plan (Amsterdam)", iconSrc: xiaomimimoIcon, featured: false },
  { id: "xiaomi-token-plan-sgp", name: "Xiaomi MiMo Token Plan (Singapore)", iconSrc: xiaomimimoIcon, featured: false },
];

export interface PiFamilyOauthProvider {
  id: string;
  name: string;
  iconSrc: string | null;
  /** pi: `/login <loginArg>`; omp: `omp auth-broker login <loginArg>`. */
  loginArg: string;
  /** Credential-store ids that mean "authorized" for this row. */
  statusIds: readonly string[];
  /** i18n key suffix (settings.piAuth.oauthDesc.*). */
  descKey: "claude" | "codex" | "copilot" | "xai" | "openrouter" | "radius" | "kimi" | "zai" | "antigravity" | "geminiCli";
}

const PI_OAUTH_PROVIDERS: readonly PiFamilyOauthProvider[] = [
  { id: "anthropic", name: "Claude Pro / Max", iconSrc: claudeIcon, loginArg: "anthropic", statusIds: ["anthropic"], descKey: "claude" },
  { id: "openai", name: "ChatGPT Plus / Pro (Codex)", iconSrc: openaiIcon, loginArg: "openai", statusIds: ["openai", "openai-codex"], descKey: "codex" },
  { id: "github-copilot", name: "GitHub Copilot", iconSrc: copilotIcon, loginArg: "github-copilot", statusIds: ["github-copilot"], descKey: "copilot" },
  { id: "xai", name: "xAI (Grok / X)", iconSrc: xaiIcon, loginArg: "xai", statusIds: ["xai"], descKey: "xai" },
  { id: "openrouter", name: "OpenRouter", iconSrc: openrouterIcon, loginArg: "openrouter", statusIds: ["openrouter"], descKey: "openrouter" },
  { id: "radius", name: "Radius", iconSrc: null, loginArg: "radius", statusIds: ["radius"], descKey: "radius" },
];

/** omp's OAuth providers (`omp auth-broker list`); login is a plain CLI
 * command, not a TUI slash command. */
const OMP_OAUTH_PROVIDERS: readonly PiFamilyOauthProvider[] = [
  { id: "anthropic", name: "Claude Pro / Max", iconSrc: claudeIcon, loginArg: "anthropic", statusIds: ["anthropic"], descKey: "claude" },
  { id: "openai-codex", name: "ChatGPT Plus / Pro (Codex)", iconSrc: openaiIcon, loginArg: "openai-codex", statusIds: ["openai-codex"], descKey: "codex" },
  { id: "github-copilot", name: "GitHub Copilot", iconSrc: copilotIcon, loginArg: "github-copilot", statusIds: ["github-copilot"], descKey: "copilot" },
  { id: "xai-oauth", name: "xAI (Grok / X)", iconSrc: xaiIcon, loginArg: "xai-oauth", statusIds: ["xai-oauth", "xai"], descKey: "xai" },
  { id: "openrouter", name: "OpenRouter", iconSrc: openrouterIcon, loginArg: "openrouter", statusIds: ["openrouter"], descKey: "openrouter" },
  { id: "kimi-code", name: "Kimi Code", iconSrc: kimiIcon, loginArg: "kimi-code", statusIds: ["kimi-code"], descKey: "kimi" },
  { id: "zai", name: "Z.AI (GLM Coding Plan)", iconSrc: zhipuIcon, loginArg: "zai", statusIds: ["zai", "zai-coding-plan"], descKey: "zai" },
  { id: "google-antigravity", name: "Google Antigravity", iconSrc: geminiIcon, loginArg: "google-antigravity", statusIds: ["google-antigravity"], descKey: "antigravity" },
  { id: "google-gemini-cli", name: "Google Code Assist (Gemini CLI)", iconSrc: geminiIcon, loginArg: "google-gemini-cli", statusIds: ["google-gemini-cli"], descKey: "geminiCli" },
];

export const PI_FAMILY_OAUTH_PROVIDERS: Record<"pi" | "omp", readonly PiFamilyOauthProvider[]> = {
  pi: PI_OAUTH_PROVIDERS,
  omp: OMP_OAUTH_PROVIDERS,
};
