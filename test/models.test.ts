import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { ModelCatalog } from "../src/models.js";
import { publicError } from "../src/errors.js";
import { providerFixture } from "./fixture.js";

const practiceModels = [
  { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", name: "DeepSeek V4.1 Flash 1017", family: "DeepSeek" },
  { id: "MiniMaxAI/MiniMax-M3.1-Flash", name: "MiniMax-M3.1-Flash", family: "MiniMax" },
  { id: "nvidia/Nemotron-3_5-Lightning", name: "Nemotron-3.5-Lightning", family: "Nemotron" },
  { id: "google/gemma-4-31B-it", name: "Gemma-4-31B-it", family: "Gemma" },
  { id: "Qwen/Qwen3.8-27B", name: "Qwen3.8-27B", family: "Qwen" },
];

test("model discovery curates five choices, preserves labels, deduplicates IDs and caches results", async t => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.url, "/deployment/v1/models");
    assert.equal(request.headers.authorization, "Bearer fixture-secret");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [
      ...practiceModels.toReversed(),
      practiceModels[0], { id: "deepseek-ai/DeepSeek-V4.1-Flash" },
      { id: "MiniMaxAI/MiniMax-M3" }, { id: "nvidia/Nemotron-3.5-Lightning" },
      { id: "Qwen/Qwen3.8-27B-Fast" }, { id: "other/ignored-model" },
      { id: "other/configured-model" }, { id: "deepseek-ai/<invalid>" }, { id: null }, null,
    ] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const catalog = new ModelCatalog(() => ({ baseUrl: `http://127.0.0.1:${address.port}/deployment/v1`, apiKey: "fixture-secret" }), () => "MiniMaxAI/MiniMax-M3.1-Flash");
  const [first, second] = await Promise.all([catalog.list(), catalog.list()]);
  assert.equal(requests, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(first.models, practiceModels);
  assert.equal(first.defaultModel, "MiniMaxAI/MiniMax-M3.1-Flash");
  first.models.length = 0;
  assert.equal((await catalog.list()).models.length, 5);
  for (const model of practiceModels) assert.deepEqual(await catalog.select(model.id), model);
  await assert.rejects(catalog.select("deepseek-ai/DeepSeek-V4.1-Flash"), /available model/);
  await assert.rejects(catalog.select("unknown/model"), /available model/);
  assert.equal(requests, 1);
});

test("practice only offers available curated models and defaults to the first available choice", async () => {
  const fixture = await providerFixture(() => "unused", ["Qwen/Qwen3.8-27B", "other/configured-model", "google/gemma-4-31B-it"]);
  try {
    const config = () => ({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret" });
    for (const preferred of [undefined, "other/configured-model", practiceModels[0]!.id]) {
      const list = await new ModelCatalog(config, () => preferred).list();
      assert.deepEqual(list.models, practiceModels.slice(3));
      assert.equal(list.defaultModel, "google/gemma-4-31B-it");
    }
  } finally { await fixture.close(); }
});

test("no matching practice models returns an empty catalog without inventing availability", async () => {
  const fixture = await providerFixture(() => "unused", ["other/configured-model"]);
  try {
    const catalog = new ModelCatalog(() => ({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret" }), () => "other/configured-model");
    assert.deepEqual(await catalog.list(), { models: [], defaultModel: null });
    await assert.rejects(catalog.select(practiceModels[0]!.id), /available model/);
  } finally { await fixture.close(); }
});

test("failed or malformed catalogs remain retryable and never expose provider response bodies", async t => {
  let status = 401;
  let body = "fixture-secret authentication detail";
  const server = createServer((_request, response) => { response.writeHead(status).end(body); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const catalog = new ModelCatalog(() => ({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "fixture-secret" }), () => undefined);
  await assert.rejects(catalog.list(), error => {
    assert.match(publicError(error), /authentication/);
    assert.doesNotMatch(publicError(error), /fixture-secret/); return true;
  });
  status = 200;
  for (body of ["not-json", "null", "{}", '{"data":{}}']) await assert.rejects(catalog.list(), /invalid model list/);
  body = '{"data":[{"id":"MiniMaxAI/MiniMax-M3.1-Flash"},{"id":"deepseek-ai/DeepSeek-V4.1-Flash-1017"}]}';
  const result = await catalog.list();
  assert.equal(result.defaultModel, "deepseek-ai/DeepSeek-V4.1-Flash-1017");
});
