import { loadProviderConfig, type ProviderConfig } from "./config.js";
import { DebateError } from "./errors.js";
import { RecordError } from "./video-record.js";

export interface ModelOption { id: string; name: string; family: "DeepSeek" | "MiniMax" | "Nemotron" | "Gemma" | "Qwen" | "Configured" }
export interface ModelList { models: ModelOption[]; defaultModel: string | null }

// Keep display labels separate from the provider's exact request IDs.
const PRACTICE_MODELS: readonly ModelOption[] = [
  { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", name: "DeepSeek V4.1 Flash 1017", family: "DeepSeek" },
  { id: "MiniMaxAI/MiniMax-M3.1-Flash", name: "MiniMax-M3.1-Flash", family: "MiniMax" },
  { id: "nvidia/Nemotron-3_5-Lightning", name: "Nemotron-3.5-Lightning", family: "Nemotron" },
  { id: "google/gemma-4-31B-it", name: "Gemma-4-31B-it", family: "Gemma" },
  { id: "Qwen/Qwen3.8-27B", name: "Qwen3.8-27B", family: "Qwen" },
];

/** Discover models at the configured endpoint; never send the provider key to the browser. */
export class ModelCatalog {
  private cached: { at: number; list: ModelList } | null = null;
  private pending: Promise<ModelList> | null = null;
  constructor(
    private readonly config: () => Omit<ProviderConfig, "model"> = loadProviderConfig,
    private readonly preferred: () => string | undefined = () => process.env.NEBIUS_MODEL,
    private readonly includeAll = false,
  ) {}

  async list(): Promise<ModelList> {
    if (this.cached && Date.now() - this.cached.at < 5 * 60_000) return structuredClone(this.cached.list);
    if (!this.pending) this.pending = this.discover();
    try { return structuredClone(await this.pending); }
    finally { this.pending = null; }
  }

  async select(id: string): Promise<ModelOption> {
    const match = (await this.list()).models.find(model => model.id === id);
    if (!match) throw new RecordError(400, "Choose an available model from the model list.");
    return match;
  }

  private async discover(): Promise<ModelList> {
    const config = this.config();
    const response = await fetch(`${config.baseUrl}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    if (!response.ok) throw new Error(`Model catalog request failed (${response.status}).`);
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new DebateError("The provider returned an invalid model list. Refresh models to try again."); }
    if (!data || typeof data !== "object" || !Array.isArray((data as { data?: unknown }).data)) {
      throw new DebateError("The provider returned an invalid model list. Refresh models to try again.");
    }
    const preferred = this.preferred()?.trim();
    const models = new Map<string, ModelOption>();
    for (const item of (data as { data: unknown[] }).data) {
      if (!item || typeof item !== "object") continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || id.length > 300 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id)) continue;
      const curated = PRACTICE_MODELS.find(model => model.id === id);
      if (curated) models.set(id, { ...curated });
      else if (this.includeAll) {
        const family = /^deepseek-ai\//i.test(id) ? "DeepSeek" : /^MiniMaxAI\//i.test(id) ? "MiniMax" : "Configured";
        models.set(id, { id, name: id.split("/").at(-1)!.replaceAll("-", " "), family });
      }
    }
    const sorted = this.includeAll
      ? [...models.values()].sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name))
      : PRACTICE_MODELS.flatMap(model => models.get(model.id) ?? []);
    const list = { models: sorted, defaultModel: sorted.find(model => model.id === preferred)?.id ?? sorted[0]?.id ?? null };
    this.cached = { at: Date.now(), list };
    return list;
  }
}
