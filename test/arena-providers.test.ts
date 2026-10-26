import { test } from "node:test";
import assert from "node:assert/strict";
import { ArenaCatalog } from "../src/arena-providers.js";
import { providerFixture } from "./fixture.js";

const modelIds = [
  "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "MiniMaxAI/MiniMax-M3.1-Flash",
  "nvidia/Nemotron-3_5-Lightning",
  "google/gemma-4-31B-it",
  "Qwen/Qwen3.8-27B",
  "meta-models/muse-spark-open",
  "zai-org/GLM-5.3-Flash",
];

test("Arena shares the seven-model allowlist across providers without exposing credentials", async () => {
  const first = await providerFixture(() => "unused", [...modelIds.toReversed(), "other/model"]);
  const second = await providerFixture(() => "unused", [modelIds[0]!, modelIds[5]!, modelIds[6]!, "other/model"]);
  try {
    const catalog = new ArenaCatalog({ FIRST_KEY: "secret-one", SECOND_KEY: "secret-two", ARENA_PROVIDERS: JSON.stringify([
      { id: "first", name: "First", baseUrl: first.baseUrl, apiKeyEnv: "FIRST_KEY", defaultModel: "other/model" },
      { id: "second", name: "Second", baseUrl: second.baseUrl, apiKeyEnv: "SECOND_KEY" },
    ]) });
    const list = await catalog.list();
    assert.deepEqual(list.models.map(model => model.key), [
      ...modelIds.map(id => `first:${id}`),
      ...[modelIds[0], modelIds[5], modelIds[6]].map(id => `second:${id}`),
    ]);
    assert.equal(list.defaultModel, `first:${modelIds[0]}`);
    assert.deepEqual(list.warnings, []);
    assert.doesNotMatch(JSON.stringify(list), /secret-one|secret-two|127\.0\.0\.1/);
    const { judge } = await catalog.comparison(`second:${modelIds[0]}`);
    assert.deepEqual(catalog.config(judge), { baseUrl: second.baseUrl, apiKey: "secret-two", model: modelIds[0] });
    await assert.rejects(catalog.comparison("first:unknown"), /available Arena judge/);
    await assert.rejects(catalog.comparison("first:other/model"), /available Arena judge/);
    for (let attempt = 0; attempt < 10; attempt++) {
      const comparison = await catalog.comparison();
      assert.ok(comparison.participants.every(candidate => modelIds.includes(candidate.id)));
      assert.ok(modelIds.includes(comparison.judge.id));
    }
  } finally { await first.close(); await second.close(); }
});

test("Arena falls back to Nebius and keeps usable providers when another catalog fails", async () => {
  const fixture = await providerFixture(() => "unused", [modelIds[0]!]);
  const failing = await providerFixture(() => "unused", ["other/model", "invalid model id"]);
  try {
    const fallback = new ArenaCatalog({ NEBIUS_BASE_URL: fixture.baseUrl, NEBIUS_API_KEY: "secret" });
    assert.equal((await fallback.list()).models[0]?.key, `nebius:${modelIds[0]}`);
    const catalog = new ArenaCatalog({ TOKEN: "secret", ARENA_PROVIDERS: JSON.stringify([
      { id: "good", name: "Good", baseUrl: fixture.baseUrl, apiKeyEnv: "TOKEN" },
      { id: "empty", name: "Empty", baseUrl: failing.baseUrl, apiKeyEnv: "TOKEN" },
    ]) });
    const result = await catalog.list();
    assert.equal(result.models.length, 1);
    assert.equal(result.warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
    const unavailable = new ArenaCatalog({ NEBIUS_BASE_URL: failing.baseUrl, NEBIUS_API_KEY: "secret" });
    await assert.rejects(unavailable.list(), /No Arena models/);
  } finally { await fixture.close(); await failing.close(); }
});

test("Arena provider profile validation rejects duplicate IDs, inline credentials and unsafe endpoints", async () => {
  const valid = { id: "a", name: "A", baseUrl: "https://example.com/v1", apiKeyEnv: "TOKEN" };
  for (const profiles of [null, [], [valid, valid], [{ ...valid, apiKey: "secret" }], [{ ...valid, baseUrl: "http://example.com" }]]) {
    await assert.rejects(new ArenaCatalog({ ARENA_PROVIDERS: JSON.stringify(profiles), TOKEN: "secret" }).list());
  }
});

test("Arena randomly selects four distinct model IDs and uses one selected judge for every candidate", async () => {
  const fixture = await providerFixture(() => "unused", modelIds.slice(0, 5));
  try {
    const catalog = new ArenaCatalog({ NEBIUS_BASE_URL: fixture.baseUrl, NEBIUS_API_KEY: "secret", NEBIUS_MODEL: modelIds[4] });
    const selected = await catalog.comparison();
    assert.equal(selected.participants.length, 4);
    assert.equal(new Set(selected.participants.map(model => model.id)).size, 4);
    assert.ok(selected.participants.every(model => modelIds.slice(0, 5).includes(model.id)));
    assert.equal(selected.judge.key, `nebius:${modelIds[4]}`);
    assert.equal((await catalog.comparison(`nebius:${modelIds[1]}`)).judge.key, `nebius:${modelIds[1]}`);
    await assert.rejects(catalog.comparison("nebius:missing"), /available Arena judge/);
  } finally { await fixture.close(); }
});

test("Arena rejects fewer than four distinct models even when providers share model IDs", async () => {
  const fixture = await providerFixture(() => "unused", modelIds.slice(0, 3));
  try {
    const catalog = new ArenaCatalog({ TOKEN: "secret", ARENA_PROVIDERS: JSON.stringify([
      { id: "first", name: "First", baseUrl: fixture.baseUrl, apiKeyEnv: "TOKEN" },
      { id: "second", name: "Second", baseUrl: fixture.baseUrl, apiKeyEnv: "TOKEN" },
    ]) });
    assert.equal((await catalog.list()).models.length, 6);
    await assert.rejects(catalog.comparison(), /at least four distinct models/);
  } finally { await fixture.close(); }
});
