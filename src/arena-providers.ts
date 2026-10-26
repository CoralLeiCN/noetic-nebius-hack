import { randomInt } from "node:crypto";
import { loadProviderConfig, type ProviderConfig } from "./config.js";
import { DebateError } from "./errors.js";
import { ModelCatalog, type ModelOption } from "./models.js";
import { RecordError } from "./video-record.js";

export interface ArenaModel extends ModelOption { providerId: string; providerName: string; key: string }
export interface ArenaModelList { models: ArenaModel[]; defaultModel: string | null; warnings: string[] }
interface Provider { id: string; name: string; config: Omit<ProviderConfig, "model">; catalog: ModelCatalog }

/** Provider credentials stay on the server; only configured profile IDs reach the client. */
export class ArenaCatalog {
  private providers: Provider[] | null = null;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private configured(): Provider[] {
    if (this.providers) return this.providers;
    let profiles: unknown;
    if (this.env.ARENA_PROVIDERS?.trim()) {
      try { profiles = JSON.parse(this.env.ARENA_PROVIDERS); }
      catch { throw new DebateError("ARENA_PROVIDERS must be a JSON array of provider profiles."); }
    } else {
      profiles = [{ id: "nebius", name: "Nebius", baseUrl: this.env.NEBIUS_BASE_URL,
        apiKeyEnv: "NEBIUS_API_KEY", ...(this.env.NEBIUS_MODEL ? { defaultModel: this.env.NEBIUS_MODEL } : {}) }];
    }
    if (!Array.isArray(profiles) || !profiles.length || profiles.length > 10) {
      throw new DebateError("Configure 1–10 Arena providers in ARENA_PROVIDERS.");
    }
    const ids = new Set<string>();
    const providers: Provider[] = [];
    for (const item of profiles) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new DebateError("Invalid Arena provider profile.");
      const data = item as Record<string, unknown>;
      if (Object.keys(data).some(key => !["id", "name", "baseUrl", "apiKeyEnv", "defaultModel"].includes(key)) ||
          typeof data.id !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(data.id) || ids.has(data.id) ||
          typeof data.name !== "string" || !data.name.trim() || data.name.length > 100 ||
          typeof data.baseUrl !== "string" || typeof data.apiKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(data.apiKeyEnv) ||
          (data.defaultModel !== undefined && (typeof data.defaultModel !== "string" || !data.defaultModel.trim()))) {
        throw new DebateError("Invalid Arena provider profile. Use unique IDs, names, API base URLs and API-key environment variable names.");
      }
      ids.add(data.id);
      let config: Omit<ProviderConfig, "model">;
      try { config = loadProviderConfig({ NEBIUS_BASE_URL: data.baseUrl, NEBIUS_API_KEY: this.env[data.apiKeyEnv] }); }
      catch { throw new DebateError(`Check the API base URL and API-key environment variable for Arena provider ${data.id}.`); }
      const preferred = data.defaultModel as string | undefined;
      providers.push({ id: data.id, name: data.name.trim(), config,
        catalog: new ModelCatalog(() => config, () => preferred) });
    }
    this.providers = providers;
    return providers;
  }

  async list(): Promise<ArenaModelList> {
    const providers = this.configured();
    const results = await Promise.allSettled(providers.map(provider => provider.catalog.list()));
    const models: ArenaModel[] = [];
    const warnings: string[] = [];
    let defaultModel: string | null = null;
    for (const [index, result] of results.entries()) {
      const provider = providers[index]!;
      if (result.status === "rejected") { warnings.push(`Models for ${provider.name} could not be loaded. Check its configuration and availability.`); continue; }
      if (!result.value.models.length) warnings.push(`No models are available from ${provider.name}.`);
      for (const model of result.value.models) models.push({ ...model, providerId: provider.id,
        providerName: provider.name, key: `${provider.id}:${model.id}` });
      if (!defaultModel && result.value.defaultModel) defaultModel = `${provider.id}:${result.value.defaultModel}`;
    }
    if (!models.length) throw new DebateError("No Arena models are available. Check the configured providers and refresh models.");
    return { models, defaultModel, warnings };
  }

  async comparison(judgeKey?: string): Promise<{ participants: ArenaModel[]; judge: ArenaModel }> {
    const catalog = await this.list();
    const judge = catalog.models.find(model => model.key === (judgeKey ?? catalog.defaultModel));
    if (!judge) throw new RecordError(400, "Choose an available Arena judge from the model list.");
    // The same model served by two providers still counts as one candidate.
    const candidates = [...new Map(catalog.models.map(model => [model.id, model])).values()];
    if (candidates.length < 4) throw new RecordError(400, "Arena needs at least four distinct models from the configured providers. Refresh models or configure another provider.");
    for (let index = candidates.length - 1; index > 0; index--) {
      const selected = randomInt(index + 1);
      [candidates[index], candidates[selected]] = [candidates[selected]!, candidates[index]!];
    }
    return { participants: candidates.slice(0, 4), judge };
  }

  config(model: ArenaModel): ProviderConfig {
    const provider = this.configured().find(provider => provider.id === model.providerId);
    if (!provider || model.key !== `${provider.id}:${model.id}`) throw new RecordError(400, "Choose a configured Arena provider.");
    return { ...provider.config, model: model.id };
  }
}
