import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import type { ArenaSnapshot } from "../src/arena-service.js";
import type { ArenaModel } from "../src/arena-providers.js";
import { ARGUMENT_CRITERIA } from "../src/argument-judge.js";

interface UiEvent { preventDefault(): void; detail?: unknown }
type Listener = (event: UiEvent) => void | Promise<void>;

class UiElement {
  value = "";
  textContent = "";
  hidden = false;
  disabled = false;
  checked = false;
  required = false;
  type = "";
  name = "";
  label = "";
  id = "";
  tagName = "";
  className = "";
  scrollTop = 0;
  scrollHeight = 0;
  style: Record<string, string> = {};
  children: UiElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  append(...children: UiElement[]): void { this.children.push(...children); }
  replaceChildren(...children: UiElement[]): void { this.children = children; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(name: string, listener: Listener): void { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  focus(): void {}
  emit(name: string, detail?: unknown): void {
    if (this.disabled && name === "click") throw new Error(`Cannot click disabled ${this.id}`);
    for (const listener of this.listeners.get(name) ?? []) void listener({ preventDefault() {}, detail });
  }
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
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
function textOf(element: UiElement): string {
  return [element.textContent, ...element.children.map(textOf)].join(" ");
}

async function ui(options: { models?: ArenaModel[]; failScoring?: boolean } = {}) {
  const html = await readFile(resolve("web/index.html"), "utf8");
  const elements = new Map<string, UiElement>();
  for (const match of html.matchAll(/id="([^"]+)"/gu)) {
    const element = new UiElement(); element.id = match[1]!; elements.set(element.id, element);
  }
  function element(id: string): UiElement {
    const found = elements.get(id);
    assert.ok(found, `The real HTML must provide #${id}`);
    return found;
  }
  const documentEvents = new Map<string, Listener[]>();
  const storage = new Map<string, string>();
  const requests: { path: string; body: Record<string, string> | null }[] = [];
  let snapshot = initial();
  const fetch = async (path: string, request?: { body: string }): Promise<Response> => {
    const body = request ? JSON.parse(request.body) as Record<string, string> : null;
    requests.push({ path, body });
    if (path === "/api/personas") return Response.json([{ id: "speaker-1", speakerName: "Alex", sourceCount: 1 }]);
    if (path === "/api/arena/models") return Response.json({ models: options.models ?? candidates, defaultModel: "test:judge", warnings: [] });
    if (path === "/api/arenas") { snapshot = initial(); return Response.json(snapshot, { status: 201 }); }
    if (path === `/api/arenas/${snapshot.id}/prepare`) {
      snapshot = { ...snapshot, status: "positions_ready", topic: body!.topic!, positions };
      return Response.json(snapshot);
    }
    if (path === `/api/arenas/${snapshot.id}/run`) {
      assert.ok(body?.side === "affirmative" || body?.side === "negative");
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
  const source = await readFile(resolve("web/arena.js"), "utf8");
  let timerId = 0;
  runInNewContext(source, {
    document: {
      getElementById: element,
      createElement: (tag: string) => { const result = new UiElement(); result.tagName = tag; return result; },
      addEventListener: (name: string, listener: Listener) => documentEvents.set(name, [...documentEvents.get(name) ?? [], listener]),
    },
    sessionStorage: { getItem: (name: string) => storage.get(name) ?? null,
      setItem: (name: string, value: string) => storage.set(name, value), removeItem: (name: string) => storage.delete(name) },
    fetch,
    // Monitor timers are deliberately idle: these tests exercise completed request responses.
    setTimeout: () => ++timerId,
  }, { filename: "web/arena.js" });
  for (const listener of documentEvents.get("workspace-screen") ?? []) void listener({ preventDefault() {}, detail: "arena" });
  await flush();
  return { element, requests, async prepare() {
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
