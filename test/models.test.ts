import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { ModelCatalog } from "../src/models.js";
import { publicError } from "../src/errors.js";

test("model discovery filters families, deduplicates IDs, preserves endpoint prefixes and caches results", async t => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.url, "/deployment/v1/models");
    assert.equal(request.headers.authorization, "Bearer fixture-secret");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [
      { id: "MiniMaxAI/MiniMax-M3" }, { id: "deepseek-ai/DeepSeek-V4.1-Flash" },
      { id: "deepseek-ai/DeepSeek-V4.1-Flash" }, { id: "other/ignored-model" },
      { id: "other/configured-model" }, { id: "deepseek-ai/<invalid>" }, { id: null }, null,
    ] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const catalog = new ModelCatalog(() => ({ baseUrl: `http://127.0.0.1:${address.port}/deployment/v1`, apiKey: "fixture-secret" }), () => "other/configured-model");
  const [first, second] = await Promise.all([catalog.list(), catalog.list()]);
  assert.equal(requests, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(first.models.map(model => model.family), ["Configured", "DeepSeek", "MiniMax"]);
  assert.equal(first.defaultModel, "other/configured-model");
  first.models.length = 0;
  assert.equal((await catalog.list()).models.length, 3);
  assert.equal((await catalog.select("MiniMaxAI/MiniMax-M3")).name, "MiniMax M3");
  await assert.rejects(catalog.select("unknown/model"), /available model/);
  assert.equal(requests, 1);
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
  body = '{"data":[{"id":"MiniMaxAI/MiniMax-M3"},{"id":"deepseek-ai/DeepSeek-V4.1-Flash"}]}';
  const result = await catalog.list();
  assert.equal(result.defaultModel, "deepseek-ai/DeepSeek-V4.1-Flash");
});
