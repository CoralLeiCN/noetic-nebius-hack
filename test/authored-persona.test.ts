import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ArenaService } from "../src/arena-service.js";
import type { ArenaModel } from "../src/arena-providers.js";
import { ARGUMENT_CRITERIA, type ArgumentJudge } from "../src/argument-judge.js";
import { DebateService, type ManagedDebateAgent } from "../src/debate-service.js";
import type { PracticeContext } from "../src/debate.js";
import { PersonaService, type Persona, type PersonaSummary } from "../src/persona-service.js";
import { createVideoServer } from "../src/server.js";
import { VideoService } from "../src/video-service.js";
import { POSITIONS, speechBreakdown } from "./fixture.js";

const socratesId = "persona-a84d56f7-915c-46f6-bf44-8f8e78f0151d";

async function savedPersona() {
  const root = await mkdtemp(join(tmpdir(), "authored-persona-test-"));
  await cp(resolve("data", socratesId), join(root, socratesId), { recursive: true });
  const videos = new VideoService(root, { analyze: async () => { throw new Error("Saved personas must not generate video records."); } });
  const personas = new PersonaService(videos, { analyze: async () => { throw new Error("Authored personas must not invoke compilation."); } });
  return { root, videos, personas };
}

test("bundled Socrates is discoverable, reviewable and downloadable without generated sources", async () => {
  const { root, videos, personas } = await savedPersona();
  const server = createVideoServer(videos, undefined, undefined, undefined, undefined, undefined, personas);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const catalogResponse = await fetch(base + "/api/personas");
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json() as PersonaSummary[];
    assert.deepEqual(catalog.map(({ id, speakerName, sourceCount, kind }) => ({ id, speakerName, sourceCount, kind })), [
      { id: socratesId, speakerName: "Socrates of Athens", sourceCount: 0, kind: "authored" },
    ]);
    const detailResponse = await fetch(`${base}/api/personas/${socratesId}`);
    assert.equal(detailResponse.status, 200);
    const persona = await detailResponse.json() as Persona;
    assert.deepEqual(persona.sourceIds, []);
    assert.deepEqual(persona.sources, []);
    assert.deepEqual(persona.analysis.dimensions, []);
    assert.match(persona.analysis.limitations.join(" "), /Authored simulation/);
    assert.match(persona.markdown, /Socrates of Athens/);
    assert.match(persona.markdown, /doctors|Doctors/);
    assert.match(persona.markdown, /gentle irony/);
    assert.match(persona.markdown, /clear declarative claim/);
    assert.doesNotMatch(persona.markdown, /\{[A-Z_]+\}|TASK: (?:PREP|SPEECH|POI_)/);
    assert.doesNotMatch(persona.markdown, /You are playing Socrates of Athens|Motion:|Difficulty:/);
    const download = await fetch(`${base}/api/personas/${socratesId}/files/persona.md`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /persona.md/);
    assert.equal(await download.text(), persona.markdown);
    assert.deepEqual(await videos.list(), []);
    const original = await readFile(join(root, socratesId, "source.md"), "utf8");
    assert.match(original, /Motion: \{MOTION\}/);
    assert.match(original, /TASK: POI_REQUEST/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});

test("authored persona manifests cannot claim compiled evidence or bypass Markdown integrity", async () => {
  const { root, personas } = await savedPersona();
  const path = join(root, socratesId, "persona.json");
  try {
    const manifestText = await readFile(path, "utf8");
    const manifest = JSON.parse(manifestText);
    for (const invalid of [
      { ...manifest, kind: undefined },
      { ...manifest, kind: "compiled" },
      { ...manifest, schemaVersion: "1.0", kind: undefined },
      { ...manifest, sourceCount: 1, sourceIds: ["video-imaginary"], sources: [{ id: "video-imaginary", title: "Invented source", sha256: "a".repeat(64) }] },
      { ...manifest, analysis: { ...manifest.analysis, dimensions: [{ dimension: "Tone and register", observation: "Invented observation", guidance: "Use gentle irony", confidence: "high", evidence: [] }] } },
    ]) {
      await writeFile(path, JSON.stringify(invalid));
      await assert.rejects(personas.get(socratesId), /manifest/);
    }
    await writeFile(path, manifestText);
    assert.equal((await personas.get(socratesId)).kind, "authored");
    await writeFile(join(root, socratesId, "persona.md"), "Modified instructions without a matching checksum.");
    await assert.rejects(personas.get(socratesId), /manifest/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Practice and all Arena participants receive the exact saved Socrates persona", async () => {
  const { root, videos, personas } = await savedPersona();
  const contexts: PracticeContext[] = [];
  const agent = (): ManagedDebateAgent => ({
    prepare: async () => POSITIONS,
    opening: async context => { contexts.push(structuredClone(context)); return "Let us examine what this policy is for."; },
    reply: async context => { contexts.push(structuredClone(context)); return "We should ask whom this knowledge serves."; },
    resetPractice() {}, dispose: async () => {},
  });
  const judge: ArgumentJudge = {
    judge: async () => ({ score: 78, rationale: "Clear reasoning.", breakdown: speechBreakdown(78), criteria: ARGUMENT_CRITERIA, provisional: true }),
    dispose: async () => {},
  };
  const practice = new DebateService(videos, async () => agent(), personas);
  const arena = new ArenaService(videos, async () => agent(), async () => judge, personas);
  try {
    const persona = await personas.get(socratesId);
    const session = await practice.create(socratesId);
    await practice.act(session.id, "prepare", "AI in education");
    await practice.act(session.id, "choose", "affirmative");
    await practice.act(session.id, "respond", "Better tools give everyone more knowledge.");
    const model = (id: string): ArenaModel => ({ id, key: `local:${id}`, name: id, family: "Configured", providerId: "local", providerName: "Local fixture" });
    const comparison = await arena.create(socratesId, { participants: ["a", "b", "c", "d"].map(model), judge: model("judge") });
    await arena.act(comparison.id, "prepare", "AI in education");
    const result = await arena.act(comparison.id, "run", "negative");
    assert.equal(result.status, "completed");
    assert.equal(contexts.length, 6);
    for (const context of contexts) {
      assert.deepEqual(context.speaker, { personaId: socratesId, name: "Socrates of Athens", personaMarkdown: persona.markdown });
      assert.equal(context.assistantSide, "negative");
      assert.doesNotMatch(JSON.stringify(context), /\{MOTION\}|TASK: POI_REQUEST|sourceCount|markdownSha256/);
    }
    assert.deepEqual(await videos.list(), []);
  } finally {
    await Promise.all([practice.close(), arena.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
