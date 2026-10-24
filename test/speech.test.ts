import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { LocalSpeech, SpeechServiceClient, loadSpeechConfig, normalizeAudio } from "../src/speech.js";
import { createSpeechServer, speechAllowedOrigins } from "../src/speech-server.js";
import { createVideoServer } from "../src/server.js";
import { VideoService } from "../src/video-service.js";

function wav(seconds = 0.1): Buffer {
  const result = Buffer.alloc(44 + Math.ceil(seconds * 16000) * 2);
  result.write("RIFF"); result.writeUInt32LE(result.length - 8, 4); result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16000, 24); result.writeUInt32LE(32000, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write("data", 36);
  result.writeUInt32LE(result.length - 44, 40);
  return result;
}

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port.");
  const url = `http://127.0.0.1:${address.port}`;
  return { url, speech: new LocalSpeech({ ...loadSpeechConfig({}), asrUrl: url, ttsUrl: url }), close: async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test("speech config permits only loopback servers without embedded credentials or paths", () => {
  assert.match(loadSpeechConfig({}).asrModel, /nemotron/);
  assert.equal(loadSpeechConfig({}).asrLanguage, "en");
  assert.equal(loadSpeechConfig({ LOCAL_ASR_LANGUAGE: " en-GB " }).asrLanguage, "en-GB");
  assert.equal(loadSpeechConfig({ LOCAL_ASR_LANGUAGE: "auto" }).asrLanguage, "auto");
  for (const language of ["English", "en\nGB", "x".repeat(36)]) {
    assert.throws(() => loadSpeechConfig({ LOCAL_ASR_LANGUAGE: language }), /LOCAL_ASR_LANGUAGE/);
  }
  for (const url of ["https://remote.example", "http://192.168.1.5", "http://localhost/v1", "http://user:secret@localhost", "http://localhost/?token=secret"]) {
    assert.throws(() => loadSpeechConfig({ LOCAL_ASR_URL: url }), /loopback/);
  }
});

test("standalone speech service supports browser preflight, readiness and the frontend proxy", async () => {
  let workersReady = true;
  const models = loadSpeechConfig({});
  const upstream = await fixture((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: workersReady ? [{ id: models.asrModel }, { id: models.ttsModel }] : [{ id: "wrong-model" }] }));
    } else if (request.url === "/v1/audio/transcriptions") {
      request.resume();
      request.on("end", () => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "A service transcript." })));
    } else response.writeHead(200, { "x-finish-reason": "stop" }).end(wav());
  });
  const origin = "http://localhost:5173";
  const gateway = createSpeechServer(upstream.speech, speechAllowedOrigins(origin)).listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("No service port.");
  const base = `http://127.0.0.1:${address.port}`;
  const client = new SpeechServiceClient(base);
  const service = new VideoService("data", { analyze: async () => { throw new Error("Unexpected analysis"); } });
  const app = createVideoServer(service, "web", undefined, undefined, undefined, undefined, undefined, client).listen(0, "127.0.0.1");
  await once(app, "listening");
  const appAddress = app.address();
  if (!appAddress || typeof appAddress === "string") throw new Error("No app port.");
  try {
    const preflight = await fetch(`${base}/api/speech/audio`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.notEqual(preflight.headers.get("access-control-allow-origin"), "*");
    const denied = await fetch(`${base}/health`, { headers: { origin: "https://unapproved.example" } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    workersReady = false;
    const unavailable = await fetch(`${base}/health`);
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).ready, false);
    workersReady = true;
    assert.equal((await client.transcribe(wav())).text, "A service transcript.");
    const direct = await fetch(`${base}/api/speech/audio`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ input: "A direct browser request." }) });
    assert.equal(direct.status, 200);
    assert.equal(direct.headers.get("access-control-allow-origin"), origin);
    assert.equal((await direct.arrayBuffer()).byteLength, wav().length);
    const proxied = await fetch(`http://127.0.0.1:${appAddress.port}/api/speech/audio`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "A proxied browser request." }) });
    assert.equal(proxied.status, 200);
    assert.equal((await proxied.arrayBuffer()).byteLength, wav().length);
    assert.throws(() => speechAllowedOrigins("*"), /exact HTTP/);
    assert.throws(() => speechAllowedOrigins("http://localhost:5173/path"), /exact HTTP/);
  } finally {
    for (const server of [app, gateway]) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await upstream.close();
  }
});

test("audio normalization creates native-compatible PCM and rejects malformed or overlong input", async () => {
  const controller = new AbortController();
  const output = await normalizeAudio(wav(), controller.signal);
  assert.equal(output.readUInt32LE(24), 16000);
  assert.equal(output.readUInt16LE(22), 1);
  assert.equal(output.readUInt32LE(40), 3200);
  await assert.rejects(normalizeAudio(Buffer.from("not audio"), controller.signal), /decode/);
  await assert.rejects(normalizeAudio(wav(121), controller.signal), /120 seconds/);
  await assert.rejects(normalizeAudio(Buffer.alloc(0), controller.signal), /16 MiB/);
});

test("speech adapter sends normalized multipart audio and returns the native transcript", async () => {
  let body = "";
  const upstream = await fixture((request, response) => {
    assert.equal(request.url, "/v1/audio/transcriptions");
    request.on("data", chunk => { body += chunk.toString("latin1"); });
    request.on("end", () => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "Evidence supports the argument." })));
  });
  try {
    assert.equal((await upstream.speech.transcribe(wav())).text, "Evidence supports the argument.");
    assert.match(body, /name="model"/);
    assert.match(body, /name="language"\r\n\r\nen\r\n/);
    assert.match(body, /nemotron/);
    assert.match(body, /RIFF/);
  } finally { await upstream.close(); }
});

test("speech adapter forwards regional language hints and omits language for automatic detection", async () => {
  const languages: (FormDataEntryValue | null)[] = [];
  const upstream = await fixture(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const form = await new Request("http://localhost/transcription", {
      method: "POST", headers: { "content-type": request.headers["content-type"]! }, body: Buffer.concat(chunks),
    }).formData();
    languages.push(form.get("language"));
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "An English argument." }));
  });
  try {
    for (const asrLanguage of ["en-GB", "auto"]) {
      const speech = new LocalSpeech({ ...loadSpeechConfig({}), asrUrl: upstream.url, asrLanguage });
      assert.equal((await speech.transcribe(wav())).text, "An English argument.");
    }
    assert.deepEqual(languages, ["en-GB", null]);
  } finally { await upstream.close(); }
});

test("speech cancels ongoing work, rejects concurrent requests, and releases capacity", async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let requests = 0;
  const upstream = await fixture((_request, response) => {
    requests++;
    if (requests === 1) entered();
    else response.writeHead(200, { "x-finish-reason": "stop" }).end(wav());
  });
  const controller = new AbortController();
  try {
    const pending = upstream.speech.speak("A clear argument.", controller.signal);
    const rejected = assert.rejects(pending, /Canceled/);
    await started;
    await assert.rejects(upstream.speech.speak("Another argument."), /busy/);
    controller.abort(new Error("Canceled"));
    await rejected;
    assert.equal((await upstream.speech.speak("Try again.")).toString("ascii", 0, 4), "RIFF");
  } finally { controller.abort(); await upstream.close(); }
});

test("truncated speech, redirects and provider errors are rejected without leaking details", async () => {
  let mode = "length";
  const upstream = await fixture((_request, response) => {
    if (mode === "length") response.writeHead(200, { "x-finish-reason": "length" }).end(wav());
    else if (mode === "redirect") response.writeHead(302, { location: "https://external.example" }).end();
    else response.writeHead(500).end("private model paths and stack traces");
  });
  try {
    await assert.rejects(upstream.speech.speak("An argument."), /finish completely/);
    mode = "redirect";
    await assert.rejects(upstream.speech.speak("An argument."), /unavailable/);
    mode = "error";
    await assert.rejects(upstream.speech.speak("An argument."), /rejected the request/);
    await assert.rejects(upstream.speech.speak("x".repeat(601)), /600 characters/);
  } finally { await upstream.close(); }
});

test("web speech routes enforce origin, JSON input shape, and return audio", async () => {
  const upstream = await fixture((_request, response) => response.writeHead(200, { "x-finish-reason": "stop" }).end(wav()));
  const service = new VideoService("data", { analyze: async () => { throw new Error("Unexpected analysis"); } });
  const server = createVideoServer(service, "web", undefined, undefined, undefined, undefined, undefined, upstream.speech).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No app port.");
  const url = `http://127.0.0.1:${address.port}/api/speech/audio`;
  const options = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "An argument." }) };
  try {
    const response = await fetch(url, options);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    assert.equal((await response.arrayBuffer()).byteLength, wav().length);
    assert.equal((await fetch(url, { ...options, body: "bad JSON" })).status, 400);
    assert.equal((await fetch(url, { ...options, body: JSON.stringify({ input: "Hi", model: "other" }) })).status, 400);
    assert.equal((await fetch(url, { ...options, headers: { ...options.headers, origin: "https://external.example" } })).status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await upstream.close();
  }
});
