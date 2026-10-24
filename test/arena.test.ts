import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaService, type ArenaSnapshot } from "../src/arena-service.js";
import { ArenaCatalog, type ArenaModel } from "../src/arena-providers.js";
import { ARGUMENT_CRITERIA, CodexArgumentJudge, type ArgumentJudge } from "../src/argument-judge.js";
import { CodexDebateAgent } from "../src/codex-agent.js";
import { DebateService, type ManagedDebateAgent } from "../src/debate-service.js";
import type { PracticeContext } from "../src/debate.js";
import { createVideoServer } from "../src/server.js";
import { VideoService } from "../src/video-service.js";
import { ModelCatalog } from "../src/models.js";
import { PersonaService } from "../src/persona-service.js";
import { POSITIONS, providerFixture, personaAnalysis, speechBreakdown, type RequestRecord } from "./fixture.js";

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

test("Arena API compares four random models through Practice and retries only failed generation and scores", { timeout: 90_000 }, async () => {
  const { root, videos, record, persona } = await sources();
  let completedOpenings = 0;
  let failedOpeningAttempts = 3;
  let judgeAttempts = 0;
  const respond = (request: RequestRecord) => {
    const input = JSON.stringify(request.body.input);
    if (input.includes("Create one debate motion")) return JSON.stringify(POSITIONS);
    if (input.includes("Evaluate only the target speech")) {
      judgeAttempts++;
      if (judgeAttempts === 2) return JSON.stringify({ rationale: "Invalid score", breakdown: speechBreakdown(120) });
      return JSON.stringify({ rationale: "Clear claims; explain consequences more fully.", breakdown: speechBreakdown(78) });
    }
    if (completedOpenings === 3 && failedOpeningAttempts > 0) {
      failedOpeningAttempts--; return { status: 503, body: "private-secret-provider-error" };
    }
    completedOpenings++;
    return `Candidate opening ${completedOpenings}`;
  };
  const first = await providerFixture(respond, ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "MiniMaxAI/MiniMax-M3.1-Flash"]);
  const second = await providerFixture(respond, ["meta-models/muse-spark-open", "zai-org/GLM-5.3-Flash"]);
  const catalog = new ArenaCatalog({ KEY_A: "secret-a", KEY_B: "secret-b", ARENA_PROVIDERS: JSON.stringify([
    { id: "first", name: "First", baseUrl: first.baseUrl, apiKeyEnv: "KEY_A" },
    { id: "second", name: "Second", baseUrl: second.baseUrl, apiKeyEnv: "KEY_B" },
  ]) });
  const arenas = new ArenaService(videos, model => CodexDebateAgent.create(catalog.config(model)), model => CodexArgumentJudge.create(catalog.config(model)));
  const debates = new DebateService(videos, async () => { throw new Error("Unused"); });
  const server = createVideoServer(videos, undefined, debates, new ModelCatalog(), catalog, arenas);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const choices = await (await fetch(base + "/api/arena/models")).json();
    assert.equal(choices.models.length, 4);
    assert.doesNotMatch(JSON.stringify(choices), /secret-|baseUrl|apiKey/);
    assert.equal((await post("/api/arenas", { speakerId: record.id })).status, 404);
    const setup = { speakerId: persona.id, judgeModel: "second:zai-org/GLM-5.3-Flash" };
    assert.equal((await post("/api/arenas", { ...setup, judgeModel: "unknown" })).status, 400);
    assert.equal((await post("/api/arenas", { ...setup, apiKey: "bad" })).status, 400);
    const creation = await post("/api/arenas", setup); assert.equal(creation.status, 201);
    const created = await creation.json() as ArenaSnapshot;
    assert.equal(new Set(created.models.participants.map(model => model.id)).size, 4);
    assert.equal(created.models.judge.key, setup.judgeModel);
    const route = `/api/arenas/${created.id}`;
    assert.equal((await post(route + "/run", { side: "affirmative" })).status, 409);
    assert.equal((await post(route + "/prepare", { topic: " " })).status, 400);
    const prepared = await (await post(route + "/prepare", { topic: "AI in education" })).json() as ArenaSnapshot;
    assert.deepEqual(prepared.positions, POSITIONS);
    assert.equal((await post(route + "/run", { side: "both" })).status, 400);
    const judgeFailure = await post(route + "/run", { side: "negative" }); assert.equal(judgeFailure.status, 502);
    const judgeState = (await judgeFailure.json()).session as ArenaSnapshot;
    assert.equal(judgeState.status, "awaiting_judgment");
    assert.equal(judgeState.results.length, 2, "the second speech is scored before the third begins");
    assert.equal(judgeState.results.filter(result => result.judgment).length, 1);
    assert.equal(judgeState.pending?.kind, "judge");
    assert.equal(completedOpenings, 2);
    const failed = await post(route + "/retry"); assert.equal(failed.status, 502);
    const failure = await failed.json() as { error: string; session: ArenaSnapshot };
    assert.doesNotMatch(failure.error, /private-secret/);
    assert.equal(failure.session.status, "positions_ready");
    assert.equal(failure.session.results.length, 3);
    assert.equal(failure.session.results.filter(result => result.judgment).length, 3);
    assert.deepEqual(failure.session.pending, { kind: "run", side: "negative" });
    assert.equal(failedOpeningAttempts, 0, "provider retries are exhausted before requiring manual recovery");
    assert.equal((await post(route + "/judge")).status, 409);
    const scored = await (await post(route + "/retry")).json() as ArenaSnapshot;
    assert.equal(scored.status, "completed");
    assert.equal(scored.side, "negative");
    assert.equal(scored.pending, null);
    assert.equal(completedOpenings, 4, "retry only generates the missing opening");
    assert.equal(judgeAttempts, 5, "successful scores are preserved across both scoring and generation retries");
    for (const result of scored.results) {
      assert.equal(result.judgment?.score, 78);
      assert.equal(result.judgment?.criteria, ARGUMENT_CRITERIA);
      assert.equal(result.judgment?.breakdown.reasoning.score, 78);
    }
    const requests = [...first.requests, ...second.requests];
    const openings = requests.filter(request => JSON.stringify(request.body.input).includes("Present two or three distinct opening arguments"));
    assert.equal(openings.length, 7, "four successful openings plus three failed HTTP attempts");
    for (const request of openings) {
      const input = JSON.stringify(request.body.input);
      assert.match(input, /Prefer concrete accessible vocabulary/);
      assert.match(input, /# Persona: Direct parliamentary debater/);
      assert.match(input, /Word budget: at most 250 words/);
      assert.match(input, /assistantSide.*negative/);
      assert.doesNotMatch(input, /Learning should be accessible|Candidate opening/);
    }
    const judgments = requests.filter(request => JSON.stringify(request.body.input).includes("Evaluate only the target speech"));
    for (const request of judgments) {
      const input = JSON.stringify(request.body.input);
      assert.equal(request.body.model, "zai-org/GLM-5.3-Flash");
      assert.match(input, /precedingSpeeches.*\[\]/);
      assert.doesNotMatch(input, /# Persona: Direct parliamentary debater|TASK: SPEECH|providerName|providerId/);
    }
    assert.ok(first.requests.every(request => request.headers.authorization === "Bearer secret-a"));
    assert.ok(second.requests.every(request => request.headers.authorization === "Bearer secret-b"));
    assert.equal((await (await fetch(base + route)).json()).results.length, 4);
    assert.equal((await post(route + "/run", { side: "affirmative" })).status, 409);
    assert.equal((await fetch(base + "/arena.js")).status, 200);
    assert.equal((await fetch(base + "/api/arenas", { method: "POST", headers: { origin: "https://example.com" } })).status, 403);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await arenas.close(); await debates.close(); await first.close(); await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

const model = (id: string): ArenaModel => ({ id, name: id, family: "Configured", providerId: "test", providerName: "Test", key: `test:${id}` });
const models = { participants: [model("a"), model("b"), model("c"), model("d")], judge: model("judge") };
const judge: ArgumentJudge = { judge: async () => ({ score: 75, rationale: "Clear", breakdown: speechBreakdown(75), criteria: ARGUMENT_CRITERIA, provisional: true }), dispose: async () => {} };

test("Arena isolates independent opening contexts, rejects concurrent runs and suppresses output after ending", async () => {
  const { root, videos, persona } = await sources();
  let started!: () => void;
  let release!: (text: string) => void;
  let disposals = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const contexts: PracticeContext[] = [];
  const service = new ArenaService(videos, async (): Promise<ManagedDebateAgent> => ({
    prepare: async () => POSITIONS,
    opening: async context => { contexts.push(context); started(); return new Promise<string>(resolve => { release = resolve; }); },
    reply: async () => { throw new Error("Arena only generates independent openings"); }, resetPractice() {}, dispose: async () => { disposals++; },
  }), async () => judge);
  try {
    await assert.rejects(service.create(persona.id, { participants: models.participants.slice(0, 3), judge: models.judge }), /four different/);
    await assert.rejects(service.create(persona.id, { participants: [model("a"), model("a"), model("b"), model("c")], judge: models.judge }), /four different/);
    await assert.rejects(service.create(persona.id, { participants: [model("a"), { ...model("a"), providerId: "other", key: "other:a" }, model("b"), model("c")], judge: models.judge }), /four different/);
    const first = await service.create(persona.id, models); const second = await service.create(persona.id, models);
    first.speaker.personaMarkdown = "Tampered";
    await service.act(first.id, "prepare", "Learning");
    const running = service.act(first.id, "run", "affirmative"); await ready;
    await assert.rejects(service.act(first.id, "run", "negative"), /unavailable/);
    assert.equal(service.get(second.id).results.length, 0);
    assert.equal(contexts[0]?.speaker?.personaMarkdown, persona.markdown);
    assert.equal(contexts[0]?.speaker?.personaId, persona.id);
    assert.equal(contexts[0]?.assistantSide, "affirmative");
    assert.deepEqual(contexts[0]?.messages, []);
    const ended = service.act(first.id, "end");
    release("Late argument"); await running; await ended;
    assert.equal(service.get(first.id).status, "ended");
    assert.equal(service.get(first.id).results.length, 0);
    assert.equal(disposals, 4);
    for (let i = 0; i < 21; i++) {
      const next = await service.create(persona.id, models);
      await service.act(next.id, "end");
    }
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("Arena publishes each score before the next opening and keeps completed scores when ending during judging", { timeout: 10_000 }, async () => {
  const { root, videos, persona } = await sources();
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  };
  const firstJudgeStarted = deferred<void>();
  const secondOpeningStarted = deferred<void>();
  const secondJudgeStarted = deferred<void>();
  const firstScore = deferred<Awaited<ReturnType<ArgumentJudge["judge"]>>>();
  const secondScore = deferred<Awaited<ReturnType<ArgumentJudge["judge"]>>>();
  const secondOpening = deferred<string>();
  const events: string[] = [];
  let judgeCalls = 0;
  const service = new ArenaService(videos, async model => ({
    prepare: async () => POSITIONS,
    opening: async () => {
      events.push(`opening:${model.id}`);
      if (model.id === "b") {
        secondOpeningStarted.resolve();
        return secondOpening.promise;
      }
      return `Opening ${model.id}`;
    },
    reply: async () => { throw new Error("Arena only generates independent openings"); },
    resetPractice() {}, dispose: async () => {},
  }), async () => ({
    judge: async input => {
      events.push(`judge:${input.text}`);
      judgeCalls++;
      if (judgeCalls === 1) { firstJudgeStarted.resolve(); return firstScore.promise; }
      secondJudgeStarted.resolve(); return secondScore.promise;
    },
    dispose: async () => {},
  }));
  try {
    const arena = await service.create(persona.id, models);
    await service.act(arena.id, "prepare", "Learning");
    const running = service.act(arena.id, "run", "affirmative");
    await firstJudgeStarted.promise;
    const judgingFirst = service.get(arena.id);
    assert.equal(judgingFirst.status, "judging");
    assert.equal(judgingFirst.results.length, 1);
    assert.equal(judgingFirst.results[0]!.judgment, null);
    assert.deepEqual(events, ["opening:a", "judge:Opening a"]);
    const judgment = await judge.judge({ topic: "Learning", positions: POSITIONS, side: "affirmative", text: "Opening a", messages: [] }, new AbortController().signal);
    firstScore.resolve(judgment);
    await secondOpeningStarted.promise;
    const generatingSecond = service.get(arena.id);
    assert.equal(generatingSecond.status, "generating_arguments");
    assert.equal(generatingSecond.results.length, 1);
    assert.equal(generatingSecond.results[0]!.judgment?.score, 75);
    assert.deepEqual(generatingSecond.pending, { kind: "run", side: "affirmative" });
    secondOpening.resolve("Opening b");
    await secondJudgeStarted.promise;
    const ended = service.act(arena.id, "end");
    secondScore.resolve(judgment);
    await running; await ended;
    const final = service.get(arena.id);
    assert.equal(final.status, "ended");
    assert.equal(final.pending, null);
    assert.equal(final.results.length, 2);
    assert.equal(final.results[0]!.judgment?.score, 75);
    assert.equal(final.results[1]!.judgment, null, "late scoring must not publish after cancellation");
    assert.deepEqual(events, ["opening:a", "judge:Opening a", "opening:b", "judge:Opening b"]);
  } finally {
    secondOpening.resolve("Cleanup");
    const cleanup = await judge.judge({ topic: "Learning", positions: POSITIONS, side: "affirmative", text: "Cleanup", messages: [] }, new AbortController().signal);
    firstScore.resolve(cleanup); secondScore.resolve(cleanup);
    await service.close(); await rm(root, { recursive: true, force: true });
  }
});
