import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaService, type ArenaSnapshot } from "../src/arena-service.js";
import { ArenaCatalog, type ArenaModel } from "../src/arena-providers.js";
import { ARENA_CRITERIA, CodexArenaJudge, type ArenaJudge } from "../src/arena-judge.js";
import { CodexDebateAgent } from "../src/codex-agent.js";
import { DebateService, type ManagedDebateAgent } from "../src/debate-service.js";
import type { PracticeContext } from "../src/debate.js";
import { createVideoServer } from "../src/server.js";
import { VideoService } from "../src/video-service.js";
import { ModelCatalog } from "../src/models.js";
import { PersonaService } from "../src/persona-service.js";
import { POSITIONS, providerFixture, personaAnalysis } from "./fixture.js";

async function sources() {
  const root = await mkdtemp(join(tmpdir(), "arena-test-"));
  const videos = new VideoService(root, { analyze: async () => ({
    remarks: [{ cueId: 1, quote: "Learning should be accessible.", uncertain: false, note: "" }],
    summary: [{ title: "Access", text: "Learning access.", remarkIndexes: [0] }], limitations: [],
  }) });
  const record = await videos.create({ title: "Education", speakerName: "Alex", sourceUrls: ["https://example.com/education"],
    transcript: Buffer.from("0:03 Learning should be accessible."), video: null }, new AbortController().signal);
  const personas = new PersonaService(videos, { analyze: async (_name, records) => personaAnalysis(records) });
  const persona = await personas.create(record.speakerName, new AbortController().signal);
  return { root, videos, record, persona };
}

test("Arena API compares providers through the Practice SDK path and retries only failed work", { timeout: 90_000 }, async () => {
  const { root, videos, record, persona } = await sources();
  let failedReplyAttempts = 3;
  let failJudge = true;
  const first = await providerFixture((request, index) => JSON.stringify(request.body.input).includes("Create one debate motion")
    ? JSON.stringify(POSITIONS) : `Affirmative argument ${index}`, ["model-a"]);
  const second = await providerFixture(request => {
    if (request.body.model === "judge-model") {
      if (failJudge) { failJudge = false; return JSON.stringify({ scores: { affirmative: 120, negative: 70 }, rationale: "Invalid" }); }
      return JSON.stringify({ scores: { affirmative: 78, negative: 74 }, rationale: "Affirmative explained access; negative addressed risks." });
    }
    if (JSON.stringify(request.body.input).includes("Respond to the human") && failedReplyAttempts > 0) {
      failedReplyAttempts--; return { status: 503, body: "private-secret-provider-error" };
    }
    return "Negative argument";
  }, ["model-b", "judge-model"]);
  const catalog = new ArenaCatalog({ KEY_A: "secret-a", KEY_B: "secret-b", ARENA_PROVIDERS: JSON.stringify([
    { id: "first", name: "First", baseUrl: first.baseUrl, apiKeyEnv: "KEY_A" },
    { id: "second", name: "Second", baseUrl: second.baseUrl, apiKeyEnv: "KEY_B" },
  ]) });
  const arenas = new ArenaService(videos, model => CodexDebateAgent.create(catalog.config(model)), model => CodexArenaJudge.create(catalog.config(model)));
  const debates = new DebateService(videos, async () => { throw new Error("Unused"); });
  const server = createVideoServer(videos, undefined, debates, new ModelCatalog(), catalog, arenas);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const choices = await (await fetch(base + "/api/arena/models")).json();
    assert.equal(choices.models.length, 3);
    assert.doesNotMatch(JSON.stringify(choices), /secret-|baseUrl|apiKey/);
    assert.equal((await post("/api/arenas", { speakerId: record.id, affirmativeModel: "first:model-a", negativeModel: "second:model-b", judgeModel: "second:judge-model" })).status, 404);
    const setup = { speakerId: persona.id, affirmativeModel: "first:model-a", negativeModel: "second:model-b", judgeModel: "second:judge-model" };
    assert.equal((await post("/api/arenas", { ...setup, negativeModel: setup.affirmativeModel })).status, 400);
    assert.equal((await post("/api/arenas", { ...setup, judgeModel: "unknown" })).status, 400);
    assert.equal((await post("/api/arenas", { ...setup, apiKey: "bad" })).status, 400);
    const creation = await post("/api/arenas", setup); assert.equal(creation.status, 201);
    const created = await creation.json() as ArenaSnapshot;
    const route = `/api/arenas/${created.id}`;
    assert.equal((await post(route + "/run")).status, 409);
    assert.equal((await post(route + "/prepare", { topic: " " })).status, 400);
    const prepared = await (await post(route + "/prepare", { topic: "AI in education" })).json() as ArenaSnapshot;
    assert.deepEqual(prepared.positions, POSITIONS);
    const failed = await post(route + "/run"); assert.equal(failed.status, 502);
    const failure = await failed.json() as { error: string; session: ArenaSnapshot };
    assert.doesNotMatch(failure.error, /private-secret/);
    assert.equal(failure.session.messages.length, 3);
    assert.equal(failure.session.pending?.kind, "run");
    assert.equal(failedReplyAttempts, 0, "provider HTTP retries are exhausted before requiring manual recovery");
    assert.equal((await post(route + "/judge")).status, 409);
    const recovered = await (await post(route + "/retry")).json() as ArenaSnapshot;
    assert.equal(recovered.status, "awaiting_judgment");
    assert.deepEqual(recovered.messages.map(message => message.side), ["affirmative", "negative", "affirmative", "negative"]);
    assert.equal(first.requests.length, 3, "preparation, opening and reply aren't repeated on retry");
    const aInput = JSON.stringify(first.requests[1]?.body.input);
    const bInput = JSON.stringify(second.requests[0]?.body.input);
    for (const input of [aInput, bInput]) {
      assert.match(input, /Prefer concrete accessible vocabulary/);
      assert.doesNotMatch(input, /Learning should be accessible/);
      assert.match(input, /Present two or three distinct opening arguments/);
      assert.match(input, /simulated debate opponent/);
    }
    const rebuilt = JSON.stringify(second.requests[4]?.body.input);
    assert.match(rebuilt, /assistantSide.*negative/);
    assert.match(rebuilt, /messages/);
    const judgeFailure = await post(route + "/judge"); assert.equal(judgeFailure.status, 502);
    assert.equal((await judgeFailure.json()).session.judgment, null);
    const scored = await (await post(route + "/retry")).json() as ArenaSnapshot;
    assert.equal(scored.status, "completed");
    assert.equal(scored.judgment?.scores.affirmative, 78);
    assert.equal(scored.judgment?.provisional, true);
    assert.equal(scored.judgment?.criteria, ARENA_CRITERIA);
    assert.ok(first.requests.every(request => request.headers.authorization === "Bearer secret-a" && request.body.model === "model-a"));
    assert.ok(second.requests.every(request => request.headers.authorization === "Bearer secret-b"));
    assert.equal((await (await fetch(base + route)).json()).messages.length, 4);
    assert.equal((await post(route + "/run")).status, 409);
    assert.equal((await fetch(base + "/arena.js")).status, 200);
    assert.equal((await fetch(base + "/api/arenas", { method: "POST", headers: { origin: "https://example.com" } })).status, 403);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await arenas.close(); await debates.close(); await first.close(); await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

const model = (id: string): ArenaModel => ({ id, name: id, family: "Configured", providerId: "test", providerName: "Test", key: `test:${id}` });
const models = { affirmative: model("a"), negative: model("b"), judge: model("judge") };
const judge: ArenaJudge = { judge: async () => ({ scores: { affirmative: 0, negative: 0 }, rationale: "Tied", criteria: ARENA_CRITERIA, provisional: true }), dispose: async () => {} };

test("Arena isolates contexts, rejects concurrent runs and suppresses output after ending", async () => {
  const { root, videos, record, persona } = await sources();
  let started!: () => void;
  let release!: (text: string) => void;
  let disposals = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const contexts: PracticeContext[] = [];
  const service = new ArenaService(videos, async (): Promise<ManagedDebateAgent> => ({
    prepare: async () => POSITIONS,
    opening: async context => { contexts.push(context); started(); return new Promise<string>(resolve => { release = resolve; }); },
    reply: async () => "Reply", resetPractice() {}, dispose: async () => { disposals++; },
  }), async () => judge);
  try {
    const first = await service.create(persona.id, models); const second = await service.create(persona.id, models);
    first.speaker.personaMarkdown = "Tampered";
    await service.act(first.id, "prepare", "Learning");
    const running = service.act(first.id, "run"); await ready;
    await assert.rejects(service.act(first.id, "run"), /unavailable/);
    assert.equal(service.get(second.id).messages.length, 0);
    assert.equal(contexts[0]?.speaker?.personaMarkdown, persona.markdown);
    assert.equal(contexts[0]?.speaker?.personaId, persona.id);
    const ended = service.act(first.id, "end");
    release("Late argument"); await running; await ended;
    assert.equal(service.get(first.id).status, "ended");
    assert.equal(service.get(first.id).messages.length, 0);
    assert.equal(disposals, 2);
    for (let i = 0; i < 21; i++) {
      const next = await service.create(persona.id, models);
      await service.act(next.id, "end");
    }
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
