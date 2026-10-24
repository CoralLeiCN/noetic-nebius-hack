import { DebateError } from "./errors.js";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** A per-model request budget; each Arena generation and score gets its own deadline. */
export function arenaRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.ARENA_REQUEST_TIMEOUT_SECONDS?.trim();
  const seconds = value ? Number(value) : 300;
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 600) {
    throw new DebateError("ARENA_REQUEST_TIMEOUT_SECONDS must be an integer between 30 and 600.");
  }
  return seconds * 1000;
}

export function loadProviderConfig(env: NodeJS.ProcessEnv = process.env): Omit<ProviderConfig, "model"> {
  function required(name: string): string {
    const value = env[name]?.trim();
    if (!value) throw new DebateError(`Set ${name} in the environment or .env file.`);
    return value;
  }
  const raw = required("NEBIUS_BASE_URL");
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new DebateError("NEBIUS_BASE_URL must be an absolute API base URL."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new DebateError("Use HTTPS for NEBIUS_BASE_URL, or HTTP on loopback for local tests.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DebateError("NEBIUS_BASE_URL must not contain credentials, a query, or a fragment.");
  }
  if (/\/(responses|chat\/completions)\/?$/.test(url.pathname)) {
    throw new DebateError("Set NEBIUS_BASE_URL to the API base, without /responses or /chat/completions.");
  }
  return {
    baseUrl: url.toString().replace(/\/+$/, ""),
    apiKey: required("NEBIUS_API_KEY"),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, selectedModel = env.NEBIUS_MODEL): ProviderConfig {
  const provider = loadProviderConfig(env);
  const model = selectedModel?.trim();
  if (!model) throw new DebateError("Set NEBIUS_MODEL in the environment or .env file, or choose a model for web debate practice.");
  return { ...provider, model };
}
