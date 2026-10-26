import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexDebateAgent } from "../src/codex-agent.js";
import { DebateService, speakerContext, type ManagedDebateAgent } from "../src/debate-service.js";
import type { PracticeContext, Snapshot } from "../src/debate.js";
import { createVideoServer } from "../src/server.js";
import { VideoService } from "../src/video-service.js";
import { loadConfig } from "../src/config.js";
import { ModelCatalog } from "../src/models.js";
import { PersonaService } from "../src/persona-service.js";
import { POSITIONS, providerFixture, personaAnalysis, speechBreakdown } from "./fixture.js";
import type { ArgumentJudgeInput } from "../src/argument-judge.js";

async function sources() {
  const root = await mkdtemp(join(tmpdir(), "debate-web-test-"));
  const service = new VideoService(root, { analyze: async () => ({
    remarks: [{ cueId: 1, quote: "Education should help everyone learn.", uncertain: false, note: "" }],
    summary: [{ title: "Access", text: "Alex supports access to learning.", remarkIndexes: [0] }], limitations: ["Short excerpt."],
  }) });
  const record = await service.create({ title: "Learning for everyone", speakerName: "Alex", sourceUrls: ["https://example.com/talk"],
    transcript: Buffer.from("0:05 Education should help everyone learn."), video: null }, new AbortController().signal);
  const personas = new PersonaService(service, { analyze: async (_name, records) => personaAnalysis(records) });
  const persona = await personas.create(record.speakerName, new AbortController().signal);
  return { root, service, record, persona };
}
async function listening(service: VideoService, debates: DebateService, models?: ModelCatalog) {
  const server = createVideoServer(service, undefined, debates, models);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  return { server, base, post: (path: string, body: unknown = {}) => fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), close: async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await debates.close();
  } };
}

test("Practice API enforces the allowlist for explicit and omitted model selections", async () => {
  const { root, service, persona } = await sources();
  const muse = "meta-models/muse-spark-open";
  const glm = "zai-org/GLM-5.3-Flash";
  const selected: (string | undefined)[] = [];
  const fixture = await providerFixture(() => "unused", ["other/model", glm, muse]);
  const debates = new DebateService(service, async model => {
    selected.push(model);
    return { prepare: async () => POSITIONS, opening: async () => "Opening", reply: async () => "Reply", resetPractice() {}, dispose: async () => {} };
  });
  const catalog = new ModelCatalog(() => ({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret" }), () => "other/model");
  const web = await listening(service, debates, catalog);
  try {
    const response = await web.post("/api/debates", { speakerId: persona.id, model: "other/model" });
    assert.equal(response.status, 400);
    assert.deepEqual(selected, []);
    const defaultResponse = await web.post("/api/debates", { speakerId: persona.id });
    assert.equal(defaultResponse.status, 201);
    assert.equal((await defaultResponse.json()).model.id, muse);
    const explicitResponse = await web.post("/api/debates", { speakerId: persona.id, model: glm });
    assert.equal(explicitResponse.status, 201);
    assert.equal((await explicitResponse.json()).model.id, glm);
    assert.deepEqual(selected, [muse, glm]);
  } finally { await web.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test("Practice API refuses an omitted model when no allowed models are available", async () => {
  const { root, service, persona } = await sources();
  const fixture = await providerFixture(() => "unused", ["other/model"]);
  const debates = new DebateService(service, async () => { assert.fail("No agent should start for an unavailable model"); });
  const catalog = new ModelCatalog(() => ({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret" }), () => "other/model");
  const web = await listening(service, debates, catalog);
  try {
    const response = await web.post("/api/debates", { speakerId: persona.id });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /available model/);
  } finally { await web.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test("web API runs a speaker debate through the actual SDK, including failed-turn recovery", { timeout: 60_000 }, async () => {
  const { root, service, record, persona } = await sources();
  const modelIds = ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "MiniMaxAI/MiniMax-M3.1-Flash"];
  const fixture = await providerFixture((request, index) => JSON.stringify(request.body.input).includes("Create one debate motion") ? JSON.stringify(POSITIONS) :
    index >= 2 && index <= 4 ? { status: 503, body: "fixture-secret provider failure" } : `Argument ${index}`, modelIds);
  const provider = () => ({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret" });
  const debates = new DebateService(service, model => CodexDebateAgent.create(loadConfig({ NEBIUS_BASE_URL: fixture.baseUrl, NEBIUS_API_KEY: "fixture-secret" }, model)));
  const web = await listening(service, debates, new ModelCatalog(provider, () => undefined));
  try {
    const catalog = await (await fetch(web.base + "/api/models")).json();
    assert.equal(catalog.models.length, 2);
    assert.doesNotMatch(JSON.stringify(catalog), /fixture-secret/);
    for (const model of ["unknown/model", "", null]) assert.equal((await web.post("/api/debates", { speakerId: persona.id, model })).status, 400);
    assert.equal((await web.post("/api/debates", { speakerId: "missing" })).status, 404);
    assert.equal((await web.post("/api/debates", { speakerId: persona.id, extra: true })).status, 400);
    const creation = await web.post("/api/debates", { speakerId: persona.id, model: modelIds[0] });
    assert.equal(creation.status, 201);
    const created = await creation.json() as Snapshot;
    assert.equal(created.speaker?.name, "Alex");
    assert.equal(created.model?.id, modelIds[0]);
    assert.equal(created.speaker?.personaMarkdown, persona.markdown);
    assert.equal((await web.post("/api/debates", { speakerId: record.id, model: modelIds[0] })).status, 404);
    const route = `/api/debates/${created.id}`;
    assert.equal((await web.post(route + "/choose", { side: "affirmative" })).status, 409);
    for (const topic of [" ", "x".repeat(2001)]) assert.equal((await web.post(route + "/prepare", { topic })).status, 400);
    assert.equal((await web.post(route + "/prepare", { topic: "AI in education" })).status, 200);
    assert.equal((await web.post(route + "/choose", { side: "neither" })).status, 400);
    const opening = await (await web.post(route + "/choose", { side: "affirmative" })).json() as Snapshot;
    assert.equal(opening.assistantSide, "negative");
    assert.equal(opening.messages[0]?.text, "Argument 1");
    const failed = await web.post(route + "/respond", { contribution: "AI helps everyone learn." });
    assert.equal(failed.status, 502);
    const failure = await failed.json() as { error: string; session: Snapshot };
    assert.doesNotMatch(failure.error, /fixture-secret/);
    assert.equal(failure.session.messages.length, 1);
    assert.equal(failure.session.pending?.kind, "reply");
    assert.equal(fixture.requests.length, 5);
    assert.equal((await web.post(route + "/respond", { contribution: "duplicate" })).status, 409);
    const retry = await (await web.post(route + "/retry")).json() as Snapshot;
    assert.deepEqual(retry.messages.map(message => message.role), ["assistant", "human", "assistant"]);
    assert.equal(retry.messages[1]?.text, "AI helps everyone learn.");
    const next = await (await web.post(route + "/respond", { contribution: "What about personalized learning?" })).json() as Snapshot;
    assert.equal(next.messages.length, 5);
    const retryInput = JSON.stringify(fixture.requests[5]?.body.input);
    assert.match(retryInput, /Prefer concrete accessible vocabulary/);
    assert.match(retryInput, /personaId/);
    assert.doesNotMatch(retryInput, /Education should help everyone learn|remarkIndexes/);
    assert.match(retryInput, /simulated debate opponent/);
    assert.match(retryInput, /assistantSide.*negative/);
    assert.match(retryInput, /# Persona: Direct parliamentary debater/);
    assert.match(retryInput, /Speech name: negative rebuttal \/ POI answer/);
    assert.doesNotMatch(retryInput, /\{SOURCE_EXCERPTS\}/);
    assert.equal(retryInput.match(/AI helps everyone learn/g)?.length, 1);
    const ended = await (await web.post(route + "/end")).json() as Snapshot;
    assert.equal(ended.status, "ended");
    assert.equal((await web.post(route + "/respond", { contribution: "late" })).status, 409);
    assert.equal((await (await fetch(web.base + route)).json() as Snapshot).messages.length, 5);
    const crossOrigin = await fetch(web.base + "/api/debates", { method: "POST", headers: { origin: "https://example.com" } });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await fetch(web.base + "/debate.js")).status, 200);
    const sharedUi = await fetch(web.base + "/ui.js");
    assert.equal(sharedUi.status, 200);
    assert.match(sharedUi.headers.get("content-type") ?? "", /text\/javascript/);
    const html = await (await fetch(web.base + "/")).text();
    assert.match(html, /src="\/ui\.js"[\s\S]*src="\/app\.js"/);
    const speechModule = await fetch(web.base + "/debate-speech.js");
    assert.equal(speechModule.status, 200);
    assert.match(speechModule.headers.get("content-type") ?? "", /text\/javascript/);
    assert.ok(fixture.requests.every(request => request.body.model === modelIds[0]));
    const miniMax = await (await web.post("/api/debates", { speakerId: persona.id, model: modelIds[1] })).json() as Snapshot;
    assert.equal(miniMax.model?.family, "MiniMax");
    assert.equal((await web.post(`/api/debates/${miniMax.id}/prepare`, { topic: "Learning" })).status, 200);
    assert.equal(fixture.requests.at(-1)?.body.model, modelIds[1]);
    assert.equal((await (await fetch(web.base + `/api/debates/${miniMax.id}`)).json() as Snapshot).model?.id, modelIds[1]);
  } finally { await web.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test("concurrent turns are rejected, sessions are isolated, and ending suppresses late model output", async () => {
  const { root, service, record, persona } = await sources();
  let release!: (value: string) => void;
  let started!: () => void;
  let disposed = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const contexts: PracticeContext[] = [];
  const debates = new DebateService(service, async (): Promise<ManagedDebateAgent> => ({
    prepare: async () => POSITIONS, opening: async context => { contexts.push(context); return "Opening"; },
    reply: async () => { started(); return new Promise<string>(resolve => { release = resolve; }); },
    resetPractice() {}, dispose: async () => { disposed++; },
  }));
  const web = await listening(service, debates);
  try {
    const first = await debates.create(persona.id);
    const second = await debates.create(persona.id);
    await debates.act(first.id, "prepare", "Learning");
    await debates.act(first.id, "choose", "negative");
    assert.equal(contexts[0]?.speaker?.name, "Alex");
    assert.equal(debates.get(second.id).messages.length, 0);
    first.speaker!.personaMarkdown = "Changed";
    assert.equal(debates.get(first.id).speaker?.personaMarkdown, persona.markdown);
    const route = `/api/debates/${first.id}`;
    const pending = web.post(route + "/respond", { contribution: "My argument" });
    await ready;
    assert.equal((await web.post(route + "/respond", { contribution: "Second argument" })).status, 409);
    const ending = web.post(route + "/end");
    // Wait for the server to accept the end before releasing the deliberately uncooperative model.
    while (debates.get(first.id).status !== "ended") await new Promise(resolve => setTimeout(resolve, 5));
    release("Late output");
    assert.equal((await ending).status, 200);
    assert.equal((await pending).status, 200);
    assert.equal(debates.get(first.id).messages.length, 1);
    assert.equal(disposed, 1);
  } finally { await web.close(); await rm(root, { recursive: true, force: true }); }
});

test("practice context contains only the compiled persona and identity", async () => {
  const { root, persona } = await sources();
  try {
    assert.deepEqual(speakerContext(persona), {
      personaId: persona.id, name: "Alex", personaMarkdown: persona.markdown,
    });
    assert.doesNotMatch(JSON.stringify(speakerContext(persona)), /Education should help everyone learn|remarkIndexes|transcript/);
    const prompt = speakerContext(persona).personaMarkdown;
    assert.match(prompt, /Prefer concrete accessible vocabulary/);
    assert.doesNotMatch(prompt, /Confidence:|Observed pattern:|Evidence references:|Source provenance|SHA-256/);
    assert.ok(!prompt.includes(persona.sourceIds[0]!));
    assert.ok(!prompt.includes(persona.analysis.dimensions[0]!.observation));
    assert.ok(!prompt.includes(persona.analysis.limitations[0]!));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("practice API retries failed judgments without regenerating either speech and disposes judge resources", async () => {
  const { root, service, persona } = await sources();
  let fail = true;
  let generations = 0;
  let disposedAgents = 0;
  let disposedJudges = 0;
  const inputs: ArgumentJudgeInput[] = [];
  const selectedModels: (string | undefined)[] = [];
  const debates = new DebateService(service, async () => ({
    prepare: async () => POSITIONS,
    opening: async () => { generations++; return "Opening"; },
    reply: async () => { generations++; return "Reply"; },
    resetPractice() {}, dispose: async () => { disposedAgents++; },
  }), undefined, async model => {
    selectedModels.push(model);
    return { judge: async input => {
      inputs.push(input);
      if (fail) throw new Error("fixture-secret provider error");
      return { score: 81, rationale: "Sound reasoning.", breakdown: speechBreakdown(81), criteria: "Provisional", provisional: true as const };
    }, dispose: async () => { disposedJudges++; } };
  });
  const web = await listening(service, debates);
  try {
    const created = await debates.create(persona.id, { id: "test-model", name: "Test", family: "Configured" });
    assert.deepEqual(selectedModels, ["test-model"]);
    const route = `/api/debates/${created.id}`;
    await web.post(route + "/prepare", { topic: "Learning" });
    const opening = await (await web.post(route + "/choose", { side: "negative" })).json() as Snapshot;
    assert.equal(opening.status, "active");
    assert.equal(opening.pending, null);
    assert.ok(opening.messages[0]?.judgmentError);
    assert.doesNotMatch(JSON.stringify(opening), /fixture-secret/);
    for (const messageIndex of ["", "-1", "1", "0.5", "00", " 0", "1e0", "Infinity", "9007199254740992", 0, null]) {
      assert.equal((await web.post(route + "/judge", { messageIndex })).status, 400);
    }
    assert.equal((await web.post(route + "/judge")).status, 400);
    fail = false;
    const evaluated = await (await web.post(route + "/judge", { messageIndex: "0" })).json() as Snapshot;
    assert.equal(evaluated.messages[0]?.judgment?.score, 81);
    assert.deepEqual(evaluated.messages[0]?.judgment?.breakdown, speechBreakdown(81));
    assert.equal(evaluated.messages[0]?.judgmentError, undefined);
    assert.equal(generations, 1);
    assert.equal((await web.post(route + "/judge", { messageIndex: "0" })).status, 409);
    const response = await (await web.post(route + "/respond", { contribution: "Reviewed human speech." })).json() as Snapshot;
    assert.equal(response.messages.length, 3);
    assert.ok(response.messages.every(message => message.judgment));
    assert.equal(inputs[2]?.text, "Reviewed human speech.");
    assert.equal(inputs[2]?.side, "negative");
    assert.deepEqual(inputs[2]?.messages.map(message => message.text), ["Opening"]);
    await web.post(route + "/end");
    assert.equal(disposedAgents, 1);
    assert.equal(disposedJudges, 1);
  } finally { await web.close(); await rm(root, { recursive: true, force: true }); }
  assert.equal(disposedAgents, 1);
  assert.equal(disposedJudges, 1);
});

test("failure to initialize a practice judge cleans up its already-created opponent", async () => {
  const { root, service, persona } = await sources();
  let disposed = 0;
  const debates = new DebateService(service, async () => ({
    prepare: async () => POSITIONS, opening: async () => "Opening", reply: async () => "Reply",
    resetPractice() {}, dispose: async () => { disposed++; },
  }), undefined, async () => { throw new Error("Judge initialization failed"); });
  try {
    await assert.rejects(debates.create(persona.id), /Judge initialization failed/);
    assert.equal(disposed, 1);
  } finally { await debates.close(); await rm(root, { recursive: true, force: true }); }
});
