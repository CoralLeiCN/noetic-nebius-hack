import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTranscript, validateAnalysis, validateRecord, type Analysis } from "../src/video-record.js";
import { CodexVideoAnalyzer, VideoService, type Analyzer, type CreateVideo } from "../src/video-service.js";
import { createVideoServer } from "../src/server.js";
import { providerFixture } from "./fixture.js";

const transcript = "Chapter 1: Question\r\n0:033 secondsWhat will you do?\r\n0:3535 secondsWe will support young people.\r\n0:4545 secondsThank you, Andy.\r\nSync to video time\r\n";
const analysis: Analysis = {
  remarks: [{ cueId: 2, quote: "We will support young people.", uncertain: false, note: "" }],
  summary: [{ title: "Support for young people", text: "Andy says he will support young people.", remarkIndexes: [0] }],
  limitations: ["Derived from captions, not verified against audio."],
};
function input(): CreateVideo {
  return { title: "A parliamentary exchange", speakerName: "Andy", sourceUrls: ["https://www.youtube.com/watch?v=example"], transcript: Buffer.from(transcript), video: null };
}
const analyzer: Analyzer = { analyze: async () => structuredClone(analysis) };

test("caption parser handles pasted YouTube timestamps, SRT, VTT and untimed text", () => {
  assert.deepEqual(parseTranscript(transcript), [
    { id: 1, startSeconds: 3, text: "What will you do?" },
    { id: 2, startSeconds: 35, text: "We will support young people." },
    { id: 3, startSeconds: 45, text: "Thank you, Andy." },
  ]);
  assert.deepEqual(parseTranscript("1\n00:00:35,100 --> 00:00:40,000\nAndy: First line.\nSecond line.\n\n2\n00:00:41,000 --> 00:00:45,000\nNext cue."), [
    { id: 1, startSeconds: 35, text: "Andy: First line.\nSecond line." },
    { id: 2, startSeconds: 41, text: "Next cue." },
  ]);
  assert.equal(parseTranscript("WEBVTT\n\n00:01.000 --> 00:02.000\nHello.")[0]?.startSeconds, 1);
  assert.deepEqual(parseTranscript("Andy: Hello.\nKemi: Reply."), [
    { id: 1, startSeconds: null, text: "Andy: Hello." }, { id: 2, startSeconds: null, text: "Kemi: Reply." },
  ]);
  assert.throws(() => parseTranscript("0:20 Later\n0:10 Earlier"), /chronological/);
  assert.throws(() => parseTranscript("0:99 Invalid"), /timestamp/);
  assert.throws(() => parseTranscript(" "), /nonempty/);
  assert.throws(() => parseTranscript("text\0"), /NUL/);
});

test("strict analysis rejects fabricated, overlapping, reordered or extra data and invalid evidence references", () => {
  const cues = parseTranscript(transcript);
  const bad = structuredClone(analysis);
  bad.remarks[0]!.quote = "Invented promise";
  assert.throws(() => validateAnalysis(bad, cues), /source cues/);
  assert.throws(() => validateAnalysis({ ...analysis, extra: true }, cues), /schema/);
  assert.throws(() => validateAnalysis({ ...analysis, remarks: [{ ...analysis.remarks[0], uncertain: true }] }, cues), /uncertainty/);
  assert.throws(() => validateAnalysis({ ...analysis, remarks: [analysis.remarks[0], analysis.remarks[0]] }, cues), /source cues/);
  assert.throws(() => validateAnalysis({ ...analysis, summary: [{ title: "Bad", text: "Bad", remarkIndexes: [1] }] }, cues), /missing remark/);
  assert.throws(() => validateAnalysis({ remarks: [], summary: [], limitations: [] }, cues), /No remarks/);
  assert.throws(() => validateAnalysis({ ...analysis, remarks: [
    { cueId: 3, quote: "Thank you, Andy.", uncertain: false, note: "" }, analysis.remarks[0],
  ] }, cues), /source cues/);
});

test("service preserves source bytes, publishes complete records atomically and detects source tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-service-test-"));
  const service = new VideoService(root, analyzer);
  try {
    const record = await service.create(input(), new AbortController().signal);
    assert.equal(validateRecord(record), record);
    assert.deepEqual(await readdir(join(root, record.id)), ["README.md", "record.json", "speaker-remarks.md", "summary.md", "transcript.txt"]);
    assert.deepEqual(await readFile(join(root, record.id, "transcript.txt")), Buffer.from(transcript));
    assert.deepEqual(await service.get(record.id), record);
    assert.equal((await service.list()).length, 1);
    assert.throws(() => validateRecord({ ...record, unknown: true }), /schema/);
    assert.throws(() => validateRecord({ ...record, transcript: { ...record.transcript, audioVerified: true } }), /schema/);
    await assert.rejects(service.artifact(record.id, "../../.env"), /not found/);
    await assert.rejects(service.artifact(record.id, "__proto__"), /not found/);
    await assert.rejects(service.get("../outside"), /not found/);
    await symlink(join(root, record.id), join(root, "video-linked"));
    await assert.rejects(service.get("video-linked"), /not found/);
    await writeFile(join(root, record.id, "transcript.txt"), "changed");
    await assert.rejects(service.get(record.id), /does not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid requests and failed or canceled generation leave no saved records", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-failure-test-"));
  let calls = 0;
  const service = new VideoService(root, { analyze: async () => { calls++; throw new Error("provider failed"); } });
  try {
    await assert.rejects(service.create({ ...input(), speakerName: " " }, new AbortController().signal), /speaker name/);
    await assert.rejects(service.create({ ...input(), sourceUrls: ["javascript:alert(1)"] }, new AbortController().signal), /HTTP/);
    await assert.rejects(service.create({ ...input(), sourceUrls: [] }, new AbortController().signal), /video or source/);
    await assert.rejects(service.create({ ...input(), transcript: Uint8Array.from([0xff]) }, new AbortController().signal), /UTF-8/);
    await assert.rejects(service.create({ ...input(), video: { name: "fake.mp4", mimeType: "video/mp4", bytes: Buffer.from("not a video") } }, new AbortController().signal), /file header/);
    assert.equal(calls, 0);
    await assert.rejects(service.create(input(), AbortSignal.abort()), /aborted/);
    assert.equal(calls, 0);
    await assert.rejects(service.create(input(), new AbortController().signal), /provider failed/);
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(root), []);
    const invalid = new VideoService(root, { analyze: async () => ({ ...analysis, extra: true }) });
    await assert.rejects(invalid.create(input(), new AbortController().signal), /schema/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function multipart(withVideo = false): FormData {
  const form = new FormData();
  form.set("title", input().title);
  form.set("speakerName", "Andy");
  form.set("sourceUrls", "https://www.youtube.com/watch?v=example");
  form.set("transcript", new File([transcript], "captions.txt", { type: "text/plain" }));
  if (withVideo) form.set("video", new File([Buffer.from([0, 0, 0, 16]), "ftypisom0000"], "talk.mp4", { type: "video/mp4" }));
  return form;
}

async function listening(service: VideoService) {
  const server = createVideoServer(service);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

test("upload API uses the real Codex SDK, enforces output schema, and serves source artifacts", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "video-sdk-test-"));
  const fixture = await providerFixture(() => JSON.stringify(analysis));
  const service = new VideoService(root, new CodexVideoAnalyzer({ baseUrl: fixture.baseUrl, apiKey: "video-fixture-secret", model: "fixture-model" }));
  const { server, base } = await listening(service);
  try {
    const response = await fetch(`${base}/api/videos`, { method: "POST", body: multipart(true) });
    assert.equal(response.status, 201, await response.clone().text());
    const record = validateRecord(await response.json());
    assert.equal(record.video?.file, "video.mp4");
    assert.equal(fixture.requests.length, 1);
    const request = fixture.requests[0]!;
    assert.equal(request.path, "/custom/v1/responses");
    assert.equal(request.headers.authorization, "Bearer video-fixture-secret");
    assert.match(JSON.stringify(request.body.input), /named speaker/);
    assert.doesNotMatch(JSON.stringify(request.body), /video-fixture-secret/);
    assert.match(JSON.stringify(request.body.text), /json_schema/);
    assert.match(JSON.stringify(request.body.text), /remarkIndexes/);
    assert.doesNotMatch(JSON.stringify(request.body.tools ?? []), /shell|exec_command|mcp__|spawn_agent/);
    const list = await (await fetch(`${base}/api/videos`)).json();
    assert.equal(list.length, 1);
    assert.equal((await fetch(`${base}/api/videos/${record.id}`)).status, 200);
    assert.equal(await (await fetch(`${base}/api/videos/${record.id}/files/transcript.txt`)).text(), transcript);
    const partial = await fetch(`${base}/api/videos/${record.id}/files/video.mp4`, { headers: { range: "bytes=4-7" } });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), "ftyp");
    assert.equal(partial.headers.get("content-range"), "bytes 4-7/16");
    const invalidRange = await fetch(`${base}/api/videos/${record.id}/files/video.mp4`, { headers: { range: "bytes=999-" } });
    assert.equal(invalidRange.status, 416);
    assert.equal((await fetch(`${base}/api/videos/${record.id}/files/.env`)).status, 404);
    assert.equal((await fetch(`${base}/api/schema`)).status, 200);
    const page = await fetch(base);
    assert.match(await page.text(), /Source library/);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal((await fetch(`${base}/api/videos`, { method: "POST", headers: { origin: "https://external.example" }, body: multipart() })).status, 403);
    const duplicate = multipart(); duplicate.append("speakerName", "Other");
    assert.equal((await fetch(`${base}/api/videos`, { method: "POST", body: duplicate })).status, 400);
    const unknown = multipart(); unknown.append("extra", "unrecognized");
    assert.equal((await fetch(`${base}/api/videos`, { method: "POST", body: unknown })).status, 400);
    assert.equal((await fetch(`${base}/api/videos`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 415);
    assert.equal(fixture.requests.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("server admits one generation at a time and releases capacity after failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-concurrency-test-"));
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const service = new VideoService(root, { analyze: async () => { entered(); await gate; throw new Error("failed"); } });
  const { server, base } = await listening(service);
  try {
    const first = fetch(`${base}/api/videos`, { method: "POST", body: multipart() });
    await started;
    assert.equal((await fetch(`${base}/api/videos`, { method: "POST", body: multipart() })).status, 429);
    release();
    const failed = await first;
    assert.equal(failed.status, 502);
    assert.doesNotMatch(await failed.text(), /stack|provider failed/);
    const bad = multipart(); bad.delete("transcript");
    assert.equal((await fetch(`${base}/api/videos`, { method: "POST", body: bad })).status, 400);
    assert.deepEqual(await readdir(root), []);
  } finally {
    release(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("upload API normalizes pasted or uploaded transcripts and rejects ambiguous inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "video-paste-test-"));
  let calls = 0;
  const service = new VideoService(root, { analyze: async () => { calls++; return structuredClone(analysis); } });
  const { server, base } = await listening(service);
  const submit = (form: FormData) => fetch(`${base}/api/videos`, { method: "POST", body: form });
  try {
    // Both transcript methods work with either a pasted video link or an uploaded video.
    for (const withVideo of [false, true]) {
      for (const paste of [false, true]) {
        const form = multipart(withVideo);
        if (withVideo) form.delete("sourceUrls");
        if (paste) { form.delete("transcript"); form.set("transcriptText", transcript); }
        const response = await submit(form);
        assert.equal(response.status, 201, await response.clone().text());
        const record = validateRecord(await response.json());
        assert.deepEqual(await readFile(join(root, record.id, "transcript.txt")), Buffer.from(transcript));
        assert.equal(record.sources[0]?.kind, withVideo ? "upload" : "url");
        assert.deepEqual(record.transcript.cues, parseTranscript(transcript));
      }
    }
    assert.equal(calls, 4);
    const both = multipart(); both.set("transcriptText", transcript);
    assert.equal((await submit(both)).status, 400);
    const blank = multipart(); blank.delete("transcript"); blank.set("transcriptText", " \n ");
    assert.equal((await submit(blank)).status, 400);
    const wrongType = multipart(); wrongType.set("transcriptText", new File([transcript], "text.txt"));
    assert.equal((await submit(wrongType)).status, 400);
    const wrongFile = multipart(); wrongFile.set("transcript", transcript);
    assert.equal((await submit(wrongFile)).status, 400);
    const tooLarge = multipart(); tooLarge.delete("transcript"); tooLarge.set("transcriptText", "é".repeat(530000));
    assert.equal((await submit(tooLarge)).status, 413);
    const tooLong = multipart(); tooLong.delete("transcript"); tooLong.set("transcriptText", "x".repeat(500001));
    assert.equal((await submit(tooLong)).status, 400);
    assert.equal(calls, 4);
    assert.equal((await service.list()).length, 4);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
