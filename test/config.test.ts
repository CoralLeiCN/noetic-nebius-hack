import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, loadProviderConfig } from "../src/config.js";
import { publicError } from "../src/errors.js";

const env = { NEBIUS_BASE_URL: "https://example.com/deployment/v1/", NEBIUS_API_KEY: "secret-for-test", NEBIUS_MODEL: "configured/model" };

test("custom endpoint paths and model IDs are preserved", () => {
  assert.deepEqual(loadConfig(env), { baseUrl: "https://example.com/deployment/v1", apiKey: env.NEBIUS_API_KEY, model: env.NEBIUS_MODEL });
  assert.equal(loadConfig({ ...env, NEBIUS_BASE_URL: "http://127.0.0.1:1234/v1" }).baseUrl, "http://127.0.0.1:1234/v1");
});

test("model discovery needs only provider credentials and a web selection overrides the environment model", () => {
  const provider = { NEBIUS_BASE_URL: env.NEBIUS_BASE_URL, NEBIUS_API_KEY: env.NEBIUS_API_KEY };
  assert.deepEqual(loadProviderConfig(provider), { baseUrl: "https://example.com/deployment/v1", apiKey: env.NEBIUS_API_KEY });
  assert.equal(loadConfig(provider, "MiniMaxAI/MiniMax-M3").model, "MiniMaxAI/MiniMax-M3");
  assert.equal(loadConfig(env, "deepseek-ai/DeepSeek-V4.1-Flash").model, "deepseek-ai/DeepSeek-V4.1-Flash");
  assert.throws(() => loadConfig(provider), /NEBIUS_MODEL/);
});

test("configuration rejects missing fields and unsafe or operation URLs", () => {
  for (const key of Object.keys(env)) assert.throws(() => loadConfig({ ...env, [key]: "" }), new RegExp(key));
  for (const url of ["not a url", "http://example.com/v1", "https://user:secret@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/v1#secret", "https://example.com/v1/responses", "https://example.com/v1/chat/completions"]) {
    assert.throws(() => loadConfig({ ...env, NEBIUS_BASE_URL: url }));
  }
});

test("provider error messages never forward response bodies or secrets", () => {
  for (const prefix of ["401", "403", "429", "400", "404", "422", "timeout", "ENOENT", "some unknown error"]) {
    const message = publicError(new Error(`${prefix}: secret-for-test body https://user:pass@example.com`));
    assert.doesNotMatch(message, /secret-for-test|user:pass|https:\/\//);
  }
});
