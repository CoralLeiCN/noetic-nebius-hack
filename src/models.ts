import { loadProviderConfig, type ProviderConfig } from "./config.js";
import { DebateError } from "./errors.js";
import { RecordError } from "./video-record.js";

export interface ModelOption { id: string; name: string; family: "DeepSeek" | "MiniMax" | "Configured" }
export interface ModelList { models: ModelOption[]; defaultModel: string | null }

/** Discover models at the configured endpoint; never send the provider key to the browser. */
export class ModelCatalog {
  private cached: { at: number; list: ModelList } | null = null;
  private pending: Promise<ModelList> | null = null;
  constructor(
    private readonly config: () => Omit<ProviderConfig, "model"> = loadProviderConfig,
    private readonly preferred: () => string | undefined = () => process.env.NEBIUS_MODEL,
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
      const family = /^deepseek-ai\//i.test(id) ? "DeepSeek" : /^MiniMaxAI\//i.test(id) ? "MiniMax" : id === preferred ? "Configured" : null;
      if (!family) continue;
      models.set(id, { id, name: id.split("/").at(-1)!.replaceAll("-", " "), family });
    }
    const sorted = [...models.values()].sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name));
    const list = { models: sorted, defaultModel: sorted.find(model => model.id === preferred)?.id ?? sorted[0]?.id ?? null };
    this.cached = { at: Date.now(), list };
    return list;
  }
}
