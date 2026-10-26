import { test } from "node:test";
import assert from "node:assert/strict";
import { UiElement, eventTarget, htmlElements, memoryStorage, runUiScript, flush, textOf } from "./ui-fixture.js";
import type { ArenaSnapshot } from "../src/arena-service.js";
import type { ArenaModel } from "../src/arena-providers.js";
import { ARGUMENT_CRITERIA } from "../src/argument-judge.js";

const model = (id: string): ArenaModel => ({ id, name: `Model ${id}`, family: "Configured", providerId: "test", providerName: "Test", key: `test:${id}` });
const candidates = ["a", "b", "c", "d", "judge"].map(model);
const positions = { motion: "Cities should remove fares.", affirmative: "Free fares widen access.", negative: "Fares fund service." };

function initial(): ArenaSnapshot {
  return { id: "00000000-0000-4000-8000-000000000001", status: "topic_entry", topic: "", positions: null,
    speaker: { personaId: "speaker-1", name: "Alex", personaMarkdown: "Explain public transport tradeoffs." },
    models: { participants: candidates.slice(0, 4), judge: candidates[4]! }, side: null, results: [], pending: null };
}
function results(): ArenaSnapshot["results"] {
  return candidates.slice(0, 4).map((candidate, index) => ({ model: candidate, text: `Independent opening ${candidate.id}.`,
    judgment: { score: 70 + index, rationale: `Feedback for ${candidate.id}.`, criteria: ARGUMENT_CRITERIA, provisional: true,
      breakdown: { clarity: { score: 70 + index, comment: `Clear claims ${candidate.id}.` },
        reasoning: { score: 70 + index, comment: `Mechanism explained ${candidate.id}.` },
        engagement: { score: 70 + index, comment: `Anticipates objections ${candidate.id}.` } } } }));
}

async function ui(options: { models?: ArenaModel[]; failScoring?: boolean; authored?: boolean; pendingRun?: boolean } = {}) {
  const { element } = await htmlElements();
  const documentEvents = eventTarget();
  const storage = new Map<string, string>();
  const requests: { path: string; body: Record<string, string> | null }[] = [];
  let snapshot = initial();
  let finishRun: ((response: Response) => void) | undefined;
  const fetch = async (path: string, request?: { body: string }): Promise<Response> => {
    const body = request ? JSON.parse(request.body) as Record<string, string> : null;
    requests.push({ path, body });
    if (path === "/api/personas") return Response.json([options.authored
      ? { id: "speaker-1", speakerName: "Socrates", kind: "authored", sourceCount: 0 }
      : { id: "speaker-1", speakerName: "Alex", sourceCount: 1 }]);
    if (path === "/api/arena/models") return Response.json({ models: options.models ?? candidates, defaultModel: "test:judge", warnings: [] });
    if (path === "/api/arenas") { snapshot = initial(); return Response.json(snapshot, { status: 201 }); }
    if (path === `/api/arenas/${snapshot.id}/prepare`) {
      snapshot = { ...snapshot, status: "positions_ready", topic: body!.topic!, positions };
      return Response.json(snapshot);
    }
    if (path === `/api/arenas/${snapshot.id}/run`) {
      assert.ok(body?.side === "affirmative" || body?.side === "negative");
      if (options.pendingRun) {
        snapshot = { ...snapshot, status: "generating_arguments", side: body.side, pending: { kind: "run", side: body.side } };
        return new Promise<Response>(resolve => { finishRun = resolve; });
      }
      snapshot = { ...snapshot, status: "completed", side: body.side, results: results() };
      if (options.failScoring) {
        snapshot.status = "awaiting_judgment"; snapshot.pending = { kind: "judge" };
        for (const result of snapshot.results.slice(2)) result.judgment = null;
        return Response.json({ error: "The judge returned invalid feedback. Retry scoring.", session: snapshot }, { status: 502 });
      }
      return Response.json(snapshot);
    }
    if (path === `/api/arenas/${snapshot.id}/retry`) {
      snapshot = { ...snapshot, status: "completed", pending: null, results: results() };
      return Response.json(snapshot);
    }
    if (path === `/api/arenas/${snapshot.id}`) return Response.json(snapshot);
    throw new Error(`Unexpected request ${path}`);
  };
  let timerId = 0;
  const timers: (() => void)[] = [];
  await runUiScript("web/arena.js", {
    document: {
      getElementById: element,
      createElement: (tag: string) => { const result = new UiElement(); result.tagName = tag; return result; },
      addEventListener: documentEvents.addEventListener,
    },
    sessionStorage: memoryStorage(storage),
    fetch,
    // Advance polling explicitly to observe intermediate state without real delays.
    setTimeout: (callback: () => void) => { timers.push(callback); return ++timerId; },
  });
  documentEvents.emit("workspace-screen", "arena");
  await flush();
  return { element, requests,
    async progress(update: Partial<ArenaSnapshot>) {
      snapshot = { ...snapshot, ...update };
      for (const timer of timers.splice(0)) timer();
      await flush();
    },
    async finish(error?: string) {
      assert.ok(finishRun);
      finishRun(error ? Response.json({ error, session: snapshot }, { status: 502 }) : Response.json(snapshot));
      await flush();
    },
    async prepare() {
    element("arena-topic").value = "  Public transport  ";
    element("arena-form").emit("submit");
    await flush();
  } };
}

test("Arena prepares with random participants and renders four automatically scored openings on the selected side", async () => {
  const app = await ui();
  assert.equal(app.element("arena-prepare").disabled, false);
  app.element("arena-judge-model").value = "test:a";
  app.element("arena-judge-model").emit("change");
  await app.prepare();
  assert.deepEqual(app.requests.filter(request => request.body), [
    { path: "/api/arenas", body: { speakerId: "speaker-1", judgeModel: "test:a" } },
    { path: "/api/arenas/00000000-0000-4000-8000-000000000001/prepare", body: { topic: "Public transport" } },
  ]);
  assert.equal(app.element("arena-run-controls").hidden, false);
  assert.equal(app.element("arena-participants").children.length, 4);
  app.element("arena-side").value = "negative";
  app.element("arena-run").emit("click");
  await flush();
  assert.deepEqual(app.requests.at(-1)?.body, { side: "negative" });
  assert.ok(app.requests.at(-1)?.path.endsWith("/run"));
  assert.equal(app.requests.filter(request => request.path.endsWith("/judge")).length, 0, "Scoring is automatic in the run request");
  assert.equal(app.element("arena-messages").children.length, 4);
  assert.equal(app.element("arena-scores").children.length, 4);
  assert.equal(app.element("arena-evaluation").hidden, false);
  assert.equal(app.element("arena-run-controls").hidden, true);
  assert.equal(app.element("arena-badge").textContent, "SCORED");
  assert.equal(app.element("arena-judgment").textContent, "4 of 4 speeches scored · NEGATIVE.");
  for (const [index, row] of app.element("arena-scores").children.entries()) {
    const candidate = candidates[index]!;
    assert.match(textOf(app.element("arena-messages").children[index]!), new RegExp(`Independent opening ${candidate.id}`));
    assert.match(textOf(row), new RegExp(`${70 + index} / 100`));
    for (const criterion of ["Clarity", "Reasoning", "Engagement"]) assert.match(textOf(row), new RegExp(`${criterion}:`));
    assert.match(textOf(row), /Score breakdown/);
    assert.match(textOf(row), /Provisional criteria/);
    assert.equal(row.children[1]!.attributes.get("aria-valuenow"), String(70 + index));
  }
});

test("Arena polling shows each score before the next opening completes and preserves it after a timeout", async () => {
  const app = await ui({ pendingRun: true });
  await app.prepare();
  app.element("arena-side").value = "affirmative";
  app.element("arena-run").emit("click");
  await flush();

  const first = results()[0]!;
  await app.progress({ status: "judging", pending: { kind: "judge" }, results: [{ ...first, judgment: null }] });
  assert.equal(app.element("arena-messages").children.length, 1);
  assert.equal(app.element("arena-scores").children.length, 0);
  assert.match(app.element("arena-status").textContent, /Scoring Test · Model a/);
  assert.equal(app.element("arena-retry").hidden, true);

  await app.progress({ status: "generating_arguments", pending: { kind: "run", side: "affirmative" }, results: [first] });
  assert.equal(app.element("arena-scores").children.length, 1);
  assert.match(textOf(app.element("arena-scores")), /70 \/ 100/);
  assert.match(app.element("arena-status").textContent, /Generating opening 2 of 4 · Test · Model b/);
  assert.match(app.element("arena-status").textContent, /1 of 4 scores ready/);
  assert.equal(app.element("arena-new").hidden, true);

  await app.progress({ status: "positions_ready" });
  await app.finish("Generation timed out after 5 minutes. Retry to continue.");
  assert.equal(app.element("arena-scores").children.length, 1);
  assert.equal(app.element("arena-messages").children.length, 1);
  assert.equal(app.element("arena-retry").hidden, false);
  assert.match(app.element("arena-error").textContent, /timed out/);
  app.element("arena-retry").emit("click");
  await flush();
  assert.equal(app.element("arena-scores").children.length, 4);
  assert.equal(app.requests.filter(request => request.path.endsWith("/run")).length, 1);
});

test("Arena scoring retry preserves four speeches and requests only unfinished scoring", async () => {
  const app = await ui({ failScoring: true });
  await app.prepare();
  app.element("arena-side").value = "affirmative";
  app.element("arena-run").emit("click");
  await flush();
  assert.equal(app.element("arena-messages").children.length, 4);
  assert.equal(app.element("arena-scores").children.length, 2);
  assert.equal(app.element("arena-retry").hidden, false);
  assert.equal(app.element("arena-retry").textContent, "Retry scoring");
  assert.match(app.element("arena-error").textContent, /invalid feedback/);
  const speeches = app.element("arena-messages").children;
  app.element("arena-retry").emit("click");
  await flush();
  assert.ok(app.requests.at(-1)?.path.endsWith("/retry"));
  assert.deepEqual(app.requests.at(-1)?.body, {});
  assert.equal(app.requests.filter(request => request.path.endsWith("/run")).length, 1);
  assert.equal(app.element("arena-messages").children, speeches, "Scoring retry retains the existing rendered speeches");
  assert.equal(app.element("arena-scores").children.length, 4);
  assert.equal(app.element("arena-retry").hidden, true);
  assert.equal(app.element("arena-error").hidden, true);
});

test("Arena requires at least four distinct model IDs before preparing", async () => {
  const duplicate = { ...candidates[0]!, providerId: "other", providerName: "Other", key: "other:a" };
  const app = await ui({ models: [...candidates.slice(0, 3), duplicate] });
  assert.equal(app.element("arena-prepare").disabled, true);
  assert.equal(app.element("arena-model-error").hidden, false);
  assert.match(app.element("arena-model-error").textContent, /at least four distinct models/);
  assert.match(app.element("arena-model-hint").textContent, /3 distinct models available/);
  await app.prepare();
  assert.equal(app.requests.filter(request => request.path === "/api/arenas").length, 0);
});

test("Arena identifies authored personas and prepares them without source records", async () => {
  const app = await ui({ authored: true });
  assert.match(textOf(app.element("arena-speaker-options")), /Socrates Authored persona/);
  assert.doesNotMatch(textOf(app.element("arena-speaker-options")), /0 sources/);
  await app.prepare();
  assert.equal(app.requests.find(request => request.path === "/api/arenas")?.body?.speakerId, "speaker-1");
});
