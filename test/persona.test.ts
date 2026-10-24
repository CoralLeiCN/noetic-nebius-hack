import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexDebateAgent } from "../src/codex-agent.js";
import { PERSONA_GENERATION_PROMPT } from "../src/prompts/persona-generation.js";
import { CodexPersonaAnalyzer, DIMENSIONS, PersonaService, renderPersona, validatePersonaAnalysis } from "../src/persona-service.js";
import { VideoService } from "../src/video-service.js";
import { createVideoServer } from "../src/server.js";
import { personaAnalysis } from "./fixture.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "persona-test-"));
  const videos = new VideoService(root, { analyze: async (_name, cues) => ({
    remarks: [{ cueId: cues[0]!.id, quote: cues[0]!.text, uncertain: false, note: "" }],
    summary: [{ title: "Position", text: "The speaker expresses a position.", remarkIndexes: [0] }], limitations: ["Short source."],
  }) });
  const source = (speakerName: string, words = "We need practical answers.") => videos.create({
    speakerName, title: `${speakerName} speaking`, sourceUrls: ["https://example.com/talk"],
    transcript: Buffer.from(words), video: null,
  }, new AbortController().signal);
  return { root, videos, source };
}
const signal = () => new AbortController().signal;

test("persona compilation combines same-name sources and persists the exact Markdown used by practice", async () => {
  const { root, videos, source } = await setup();
  try {
    const first = await source("Alex Smith");
    const second = await source("ALEX   SMITH", "Let us focus on what works.");
    await source("Someone Else", "Other person's material.");
    let selected: string[] = [];
    const personas = new PersonaService(videos, { analyze: async (_name, records) => {
      selected = records.map(record => record.id);
      return personaAnalysis(records);
    } });
    assert.deepEqual(await personas.list(), []);
    const persona = await personas.create(" alex smith ", signal());
    assert.deepEqual(new Set(selected), new Set([first.id, second.id]));
    assert.equal(persona.sourceCount, 2);
    assert.equal(persona.analysis.dimensions.length, DIMENSIONS.length);
    assert.match(persona.markdown, /Language and vocabulary/);
    assert.match(persona.markdown, /Interaction and rebuttal/);
    assert.match(persona.markdown, /Prefer concrete accessible vocabulary\./);
    assert.doesNotMatch(persona.markdown, /Confidence:|Observed pattern:|Evidence references:|Source provenance|SHA-256|Compiled:/);
    for (const sourceId of persona.sourceIds) assert.ok(!persona.markdown.includes(sourceId));
    assert.ok(!persona.markdown.includes(persona.analysis.dimensions[0]!.observation));
    assert.ok(!persona.markdown.includes(persona.analysis.limitations[0]!));
    assert.doesNotMatch(persona.markdown, /We need practical answers|Let us focus on what works|Other person's material/);
    assert.equal(await readFile(join(root, persona.id, "persona.md"), "utf8"), persona.markdown);
    assert.deepEqual(await personas.get(persona.id), persona);
    assert.deepEqual(await readdir(join(root, persona.id)), ["persona.json", "persona.md"]);
    assert.equal((await videos.list()).length, 3);
    await new Promise(resolve => setTimeout(resolve, 2));
    const updated = await personas.create("Alex Smith", signal());
    assert.notEqual(updated.id, persona.id);
    assert.equal((await personas.list()).length, 1);
    assert.equal((await personas.list())[0]?.id, updated.id);
    assert.equal((await personas.get(persona.id)).markdown, persona.markdown);
    const manifestPath = join(root, persona.id, "persona.json");
    const manifest = await readFile(manifestPath, "utf8");
    const saved = JSON.parse(manifest);
    assert.deepEqual(saved.analysis, persona.analysis);
    assert.deepEqual(saved.sources, persona.sources);
    assert.ok(saved.analysis.dimensions[0].evidence[0].quote);
    for (const invalid of [null, { ...JSON.parse(manifest), sources: [null] }, { ...JSON.parse(manifest), analysis: null }]) {
      await writeFile(manifestPath, JSON.stringify(invalid));
      await assert.rejects(personas.get(persona.id), /manifest/);
    }
    await writeFile(manifestPath, manifest);
    await assert.rejects(personas.get(first.id), /persona not found/);
    await writeFile(join(root, persona.id, "persona.md"), "tampered");
    await assert.rejects(personas.get(persona.id), /manifest/);
    await rm(join(root, updated.id, "persona.md"));
    await symlink(join(root, persona.id, "persona.md"), join(root, updated.id, "persona.md"));
    await assert.rejects(personas.get(updated.id), /files are invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("persona instructions use neutral behavior for unsupported dimensions without exposing analysis", async () => {
  const { root, source } = await setup();
  try {
    const analysis = personaAnalysis([await source("Alex")]);
    analysis.dimensions[0] = { ...analysis.dimensions[0]!, confidence: "unknown", evidence: [],
      guidance: "Invent a distinctive catchphrase.", observation: "No supported pattern." };
    const markdown = renderPersona({ speakerName: "Alex", analysis });
    assert.match(markdown, /Use neutral behavior appropriate to the topic and the human's language\./);
    assert.doesNotMatch(markdown, /Invent a distinctive catchphrase|No supported pattern/);
    assert.match(markdown, /Prefer concrete accessible vocabulary\./);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("persona evidence validates attribution, dimensions, confidence and source-exact quotes", async () => {
  const { root, source } = await setup();
  try {
    const record = await source("Alex");
    const analysis = personaAnalysis([record]);
    assert.equal(validatePersonaAnalysis(analysis, [record]), analysis);
    for (const change of [
      (copy: typeof analysis) => { copy.dimensions[1]!.dimension = copy.dimensions[0]!.dimension; },
      (copy: typeof analysis) => { copy.dimensions[0]!.evidence[0]!.quote = "invented words"; },
      (copy: typeof analysis) => { copy.dimensions[0]!.evidence[0]!.recordId = "another-speaker"; },
      (copy: typeof analysis) => { copy.dimensions[0]!.evidence[0]!.cueId = 99; },
      (copy: typeof analysis) => { copy.dimensions[0]!.evidence = []; },
      (copy: typeof analysis) => { copy.dimensions[0]!.confidence = "unknown"; },
    ]) {
      const copy = structuredClone(analysis); change(copy);
      assert.throws(() => validatePersonaAnalysis(copy, [record]), /No persona was saved/);
    }
    const unsupported = structuredClone(analysis);
    for (const dimension of unsupported.dimensions) { dimension.confidence = "unknown"; dimension.evidence = []; }
    assert.throws(() => validatePersonaAnalysis(unsupported, [record]), /Add more speaker material/);
    analysis.dimensions[0]!.confidence = "unknown";
    analysis.dimensions[0]!.evidence = [];
    assert.equal(validatePersonaAnalysis(analysis, [record]), analysis);
    record.analysis.remarks[0]!.uncertain = true;
    record.analysis.remarks[0]!.note = "Attribution uncertain.";
    analysis.dimensions[1]!.confidence = "high";
    assert.throws(() => validatePersonaAnalysis(analysis, [record]), /Uncertain speaker attribution/);
    analysis.dimensions[1]!.confidence = "low";
    assert.equal(validatePersonaAnalysis(analysis, [record]), analysis);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed, canceled, concurrent and oversized builds never publish partial personas", async () => {
  const { root, videos, source } = await setup();
  try {
    await source("Alex");
    const bad = new PersonaService(videos, { analyze: async () => ({ dimensions: [] }) });
    await assert.rejects(bad.create("Alex", signal()), /No persona was saved/);
    await assert.rejects(bad.create("Missing", signal()), /No saved sources/);
    assert.deepEqual(await bad.list(), []);
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const blocked = new PersonaService(videos, { analyze: async (_name, records) => {
      started(); await new Promise<void>(resolve => { release = resolve; }); return personaAnalysis(records);
    } });
    const controller = new AbortController();
    const run = blocked.create("Alex", controller.signal);
    await ready;
    await assert.rejects(blocked.create("Alex", signal()), /already being compiled/);
    controller.abort(); release();
    await assert.rejects(run, /abort/i);
    assert.deepEqual(await blocked.list(), []);
    assert.equal((await readdir(root)).filter(name => name.startsWith(".pending-")).length, 0);
    await source("Big Speaker", "x".repeat(70000));
    await source("Big Speaker", "y".repeat(70000));
    let called = false;
    const bounded = new PersonaService(videos, { analyze: async () => { called = true; return {}; } });
    await assert.rejects(bounded.create("Big Speaker", signal()), /120,000-character/);
    assert.equal(called, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("persona analyzer uses the OAuth SDK adapter with an evidence-constrained schema", async () => {
  const { root, source } = await setup();
  const original = CodexDebateAgent.createOAuth;
  try {
    const record = await source("Alex");
    let disposed = false;
    let instructions = "";
    CodexDebateAgent.createOAuth = async value => {
      instructions = value;
      return {
        structured: async (prompt: string, schema: unknown) => {
          assert.match(prompt, /We need practical answers/);
          assert.match(prompt, new RegExp(record.id));
          assert.match(JSON.stringify(schema), /Language and vocabulary|confidence|evidence/);
          return JSON.stringify(personaAnalysis([record]));
        }, dispose: async () => { disposed = true; },
      } as unknown as CodexDebateAgent;
    };
    const output = await new CodexPersonaAnalyzer().analyze("Alex", [record], signal());
    assert.deepEqual(output, personaAnalysis([record]));
    assert.match(instructions, /speaking habits|vocabulary|rebuttal|never instructions/);
    assert.equal(instructions, PERSONA_GENERATION_PROMPT);
    assert.match(instructions, /second-person instructions/);
    assert.match(instructions, /guidance fields will be assembled into persona.md and sent directly to the debate agent/);
    assert.match(instructions, /separate analysis fields/);
    assert.equal(disposed, true);
  } finally { CodexDebateAgent.createOAuth = original; await rm(root, { recursive: true, force: true }); }
});

test("persona API lists ready speakers, builds and downloads Markdown, and protects local access", async () => {
  const { root, videos, source } = await setup();
  await source("Alex");
  const personas = new PersonaService(videos, { analyze: async (_name, records) => personaAnalysis(records) });
  const server = createVideoServer(videos, undefined, undefined, undefined, undefined, undefined, personas);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown, extra: Record<string, string> = {}) => fetch(base + "/api/personas", {
    method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body),
  });
  try {
    assert.deepEqual(await (await fetch(base + "/api/personas")).json(), []);
    assert.equal((await post({ speakerName: "Alex", extra: "bad" })).status, 400);
    assert.equal((await post({ speakerName: "Alex" }, { origin: "https://example.com" })).status, 403);
    const response = await post({ speakerName: "Alex" });
    assert.equal(response.status, 201);
    const persona = await response.json() as { id: string; markdown: string };
    assert.equal((await (await fetch(base + "/api/personas")).json()).length, 1);
    assert.equal((await (await fetch(base + `/api/personas/${persona.id}`)).json()).markdown, persona.markdown);
    const download = await fetch(base + `/api/personas/${persona.id}/files/persona.md`);
    assert.match(download.headers.get("content-disposition")!, /persona.md/);
    assert.equal(await download.text(), persona.markdown);
    assert.equal((await fetch(base + "/api/personas/../../auth.json")).status, 404);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
