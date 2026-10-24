import { test } from "node:test";
import assert from "node:assert/strict";
import { ArenaCatalog } from "../src/arena-providers.js";
import { providerFixture } from "./fixture.js";

test("Arena discovers arbitrary models across configured providers without exposing credentials", async () => {
  const first = await providerFixture(() => "unused", ["provider/model-a"]);
  const second = await providerFixture(() => "unused", ["provider/model-a", "other/model-b"]);
  try {
    const catalog = new ArenaCatalog({ FIRST_KEY: "secret-one", SECOND_KEY: "secret-two", ARENA_PROVIDERS: JSON.stringify([
      { id: "first", name: "First", baseUrl: first.baseUrl, apiKeyEnv: "FIRST_KEY", defaultModel: "provider/model-a" },
      { id: "second", name: "Second", baseUrl: second.baseUrl, apiKeyEnv: "SECOND_KEY" },
    ]) });
    const list = await catalog.list();
    assert.equal(list.models.length, 3);
    assert.equal(list.defaultModel, "first:provider/model-a");
    assert.deepEqual(list.warnings, []);
    assert.doesNotMatch(JSON.stringify(list), /secret-one|secret-two|127\.0\.0\.1/);
    const model = await catalog.select("second:provider/model-a");
    assert.deepEqual(catalog.config(model), { baseUrl: second.baseUrl, apiKey: "secret-two", model: "provider/model-a" });
    await assert.rejects(catalog.select("first:unknown"), /available Arena model/);
  } finally { await first.close(); await second.close(); }
});

test("Arena falls back to Nebius and keeps usable providers when another catalog fails", async () => {
  const fixture = await providerFixture(() => "unused", ["any/model"]);
  const failing = await providerFixture(() => "unused", ["invalid model id"]);
  try {
    const fallback = new ArenaCatalog({ NEBIUS_BASE_URL: fixture.baseUrl, NEBIUS_API_KEY: "secret" });
    assert.equal((await fallback.list()).models[0]?.key, "nebius:any/model");
    const catalog = new ArenaCatalog({ TOKEN: "secret", ARENA_PROVIDERS: JSON.stringify([
      { id: "good", name: "Good", baseUrl: fixture.baseUrl, apiKeyEnv: "TOKEN" },
      { id: "empty", name: "Empty", baseUrl: failing.baseUrl, apiKeyEnv: "TOKEN" },
    ]) });
    const result = await catalog.list();
    assert.equal(result.models.length, 1);
    assert.equal(result.warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  } finally { await fixture.close(); await failing.close(); }
});

test("Arena provider profile validation rejects duplicate IDs, inline credentials and unsafe endpoints", async () => {
  const valid = { id: "a", name: "A", baseUrl: "https://example.com/v1", apiKeyEnv: "TOKEN" };
  for (const profiles of [null, [], [valid, valid], [{ ...valid, apiKey: "secret" }], [{ ...valid, baseUrl: "http://example.com" }]]) {
    await assert.rejects(new ArenaCatalog({ ARENA_PROVIDERS: JSON.stringify(profiles), TOKEN: "secret" }).list());
  }
});
