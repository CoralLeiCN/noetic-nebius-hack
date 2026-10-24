import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Speech, SpeechServiceClient, loadSpeechConfig } from "../src/speech.js";
import { createSpeechServer, speechAllowedOrigins } from "../src/speech-server.js";
import { createVideoServer } from "../src/server.js";
import { VideoService } from "../src/video-service.js";
import { RecordError } from "../src/video-record.js";

const credentials = {
  TTS_PROVIDER: "elevenlabs",
  ELEVENLABS_API_KEY: "test-private-key",
  ELEVENLABS_VOICE_ID: "test-voice-id",
};
const reformerVoiceId = "6osMNatXqZrKCuGTB2bV";

function pcmResponse(bytes = new Uint8Array([0, 0, 255, 127, 0, 128])): Response {
  return new Response(bytes, { headers: { "content-type": "audio/pcm" } });
}

test("speech provider defaults to local and validates ElevenLabs configuration only when selected", () => {
  assert.equal(loadSpeechConfig({}).ttsProvider, "local");
  assert.equal(loadSpeechConfig({ TTS_PROVIDER: "local" }).elevenLabs, undefined);
  assert.throws(() => loadSpeechConfig({ TTS_PROVIDER: "unknown" }), /TTS_PROVIDER/);
  assert.throws(() => loadSpeechConfig({ TTS_PROVIDER: "elevenlabs" }), /ELEVENLABS_API_KEY/);
  const defaultVoice = { TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "test-key" };
  assert.equal(loadSpeechConfig(defaultVoice).elevenLabs?.voiceId, "JBFqnCBsd6RMkjVDRZzb");
  assert.equal(loadSpeechConfig({ ...defaultVoice, ELEVENLABS_VOICE_ID: "  " }).elevenLabs?.voiceId, "JBFqnCBsd6RMkjVDRZzb");
  assert.equal(loadSpeechConfig(credentials).elevenLabs?.voiceId, "test-voice-id");
  assert.equal(loadSpeechConfig(credentials).elevenLabs?.modelId, "eleven_multilingual_v2");
  assert.equal(loadSpeechConfig({ ...credentials, ELEVENLABS_MODEL_ID: "custom-model" }).elevenLabs?.modelId, "custom-model");
});

test("ElevenLabs sends authenticated text to the selected voice and returns playable WAV", async () => {
  let calls = 0;
  const request: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), "https://api.elevenlabs.io/v1/text-to-speech/test-voice-id?output_format=pcm_24000");
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal instanceof AbortSignal);
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("xi-api-key"), credentials.ELEVENLABS_API_KEY);
    assert.equal(headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(options?.body)), { text: "A persuasive argument.", model_id: "custom-model" });
    return pcmResponse();
  };
  const speech = new Speech(loadSpeechConfig({ ...credentials, ELEVENLABS_MODEL_ID: "custom-model" }), request);
  const audio = await speech.speak("A persuasive argument.");
  assert.equal(calls, 1);
  assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  assert.equal(audio.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(audio.readUInt32LE(4), audio.length - 8);
  assert.equal(audio.readUInt16LE(20), 1);
  assert.equal(audio.readUInt16LE(22), 1);
  assert.equal(audio.readUInt32LE(24), 24000);
  assert.equal(audio.readUInt32LE(28), 48000);
  assert.equal(audio.readUInt16LE(32), 2);
  assert.equal(audio.readUInt16LE(34), 16);
  assert.equal(audio.toString("ascii", 36, 40), "data");
  assert.equal(audio.readUInt32LE(40), 6);
  assert.deepEqual(audio.subarray(44), Buffer.from([0, 0, 255, 127, 0, 128]));
  await assert.rejects(speech.speak(" "), /600 characters/);
  await assert.rejects(speech.speak("x".repeat(601)), /600 characters/);
  assert.equal(calls, 1, "invalid input must not incur a provider call");
});

test("voice catalog exposes provider choices without credentials and rejects unavailable voices before synthesis", async () => {
  const requests: string[] = [];
  const speech = new Speech(loadSpeechConfig(credentials), async url => { requests.push(String(url)); return pcmResponse(); });
  const catalog = await speech.voices();
  assert.equal(catalog.provider, "elevenlabs");
  assert.equal(catalog.defaultVoiceId, credentials.ELEVENLABS_VOICE_ID);
  assert.ok(catalog.voices.some(voice => voice.id === reformerVoiceId && voice.name === "The Rising Reformer"));
  assert.equal(catalog.speakerDefaults["andy burnham"], reformerVoiceId);
  assert.doesNotMatch(JSON.stringify(catalog), /test-private-key|apiKey/);
  assert.equal(requests.length, 0, "listing choices must not request cloud synthesis");
  await speech.speak("A reformer's argument.", undefined, reformerVoiceId);
  assert.equal(requests[0], `https://api.elevenlabs.io/v1/text-to-speech/${reformerVoiceId}?output_format=pcm_24000`);
  await assert.rejects(speech.speak("An argument.", undefined, "unlisted-voice"), error => error instanceof RecordError && error.status === 400);
  assert.equal(requests.length, 1);
  const local = new Speech(loadSpeechConfig({}), async () => { throw new Error("Unexpected local synthesis"); });
  const localCatalog = await local.voices();
  assert.equal(localCatalog.provider, "local");
  assert.equal(localCatalog.defaultVoiceId, "neutral_female");
  assert.deepEqual(localCatalog.voices.map(voice => voice.id), ["neutral_female"]);
  assert.deepEqual(localCatalog.speakerDefaults, {});
  await assert.rejects(local.speak("An argument.", undefined, reformerVoiceId), error => error instanceof RecordError && error.status === 400);
});

test("voice choice and catalog pass through the web proxy and speech gateway", async () => {
  const requestedVoices: string[] = [];
  const speech = new Speech(loadSpeechConfig(credentials), async url => {
    requestedVoices.push(new URL(String(url)).pathname.split("/").at(-1)!);
    return pcmResponse();
  });
  const origin = "http://localhost:5173";
  const gateway = createSpeechServer(speech, speechAllowedOrigins(origin)).listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress && typeof gatewayAddress !== "string");
  const base = `http://127.0.0.1:${gatewayAddress.port}`;
  const client = new SpeechServiceClient(base);
  const service = new VideoService("data", { analyze: async () => { throw new Error("Unexpected analysis"); } });
  const app = createVideoServer(service, "web", undefined, undefined, undefined, undefined, undefined, client).listen(0, "127.0.0.1");
  await once(app, "listening");
  const appAddress = app.address();
  assert.ok(appAddress && typeof appAddress !== "string");
  const appBase = `http://127.0.0.1:${appAddress.port}`;
  try {
    const catalogResponse = await fetch(`${appBase}/api/speech/voices`);
    assert.equal(catalogResponse.status, 200);
    assert.deepEqual(await catalogResponse.json(), await speech.voices());
    const preflight = await fetch(`${base}/api/speech/voices`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET");
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    const direct = await fetch(`${base}/api/speech/voices`, { headers: { origin } });
    assert.equal(direct.status, 200);
    assert.equal(direct.headers.get("access-control-allow-origin"), origin);
    assert.equal((await fetch(`${base}/api/speech/voices`, { headers: { origin: "https://unapproved.example" } })).status, 403);
    const speak = (body: unknown) => fetch(`${appBase}/api/speech/audio`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const selected = await speak({ input: "A reformer's argument.", voiceId: reformerVoiceId });
    assert.equal(selected.status, 200);
    assert.equal(selected.headers.get("content-type"), "audio/wav");
    assert.equal(Buffer.from(await selected.arrayBuffer()).toString("ascii", 0, 4), "RIFF");
    assert.equal((await speak({ input: "A default argument." })).status, 200);
    assert.deepEqual(requestedVoices, [reformerVoiceId, credentials.ELEVENLABS_VOICE_ID]);
    for (const voiceId of ["unknown-voice", "", "  ", "../path", "x".repeat(129), 42, null]) {
      assert.equal((await speak({ input: "An argument.", voiceId })).status, 400);
    }
    assert.equal((await speak({ input: "An argument.", voiceId: reformerVoiceId, model: "other" })).status, 400);
    assert.equal(requestedVoices.length, 2, "invalid selections must never reach the provider");
  } finally {
    for (const server of [app, gateway]) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});

test("ElevenLabs errors are sanitized, preserve rate limiting, and release capacity", async () => {
  let mode: number | "network" | "ok" = 401;
  const speech = new Speech(loadSpeechConfig(credentials), async () => {
    if (mode === "ok") return pcmResponse();
    if (mode === "network") throw new Error("private network detail test-private-key");
    return new Response("private provider detail test-private-key", { status: mode });
  });
  for (const status of [401, 403, 404, 429, 500]) {
    mode = status;
    await assert.rejects(speech.speak("An argument."), error => {
      assert.ok(error instanceof RecordError);
      assert.equal(error.status, status === 429 ? 429 : 502);
      if (status === 404) assert.match(error.message, /My Voices/);
      assert.doesNotMatch(error.message, /private|test-private-key/);
      return true;
    });
  }
  mode = "network";
  await assert.rejects(speech.speak("An argument."), error => {
    assert.ok(error instanceof RecordError);
    assert.equal(error.status, 503);
    assert.match(error.message, /ElevenLabs speech is unavailable/);
    assert.match(error.message, /internet|provider/i);
    assert.doesNotMatch(error.message, /private|test-private-key/);
    return true;
  });
  mode = "ok";
  assert.equal((await speech.speak("Try again.")).toString("ascii", 0, 4), "RIFF");
});

test("ElevenLabs rejects malformed and oversized audio", async () => {
  const responses = [
    () => pcmResponse(new Uint8Array()),
    () => pcmResponse(new Uint8Array([0])),
    () => new Response('{}', { headers: { "content-type": "application/json" } }),
    () => pcmResponse(new Uint8Array(9 * 1024 * 1024)),
  ];
  for (const response of responses) {
    const speech = new Speech(loadSpeechConfig(credentials), async () => response());
    await assert.rejects(speech.speak("An argument."), error => {
      assert.ok(error instanceof RecordError);
      assert.equal(error.status, 502);
      return true;
    });
  }
});

test("ElevenLabs shares admission with transcription and cancellation frees the slot", async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const speech = new Speech(loadSpeechConfig(credentials), async (_url, options) => {
    if (++calls > 1) return pcmResponse();
    entered();
    return new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = assert.rejects(speech.speak("An argument.", controller.signal), /Canceled/);
  await started;
  await assert.rejects(speech.speak("Another argument."), /busy/);
  await assert.rejects(speech.transcribe(new Uint8Array([0])), /busy/);
  controller.abort(new Error("Canceled"));
  await pending;
  assert.equal((await speech.speak("Try again.")).toString("ascii", 0, 4), "RIFF");
  assert.equal(calls, 2);
});

test("ElevenLabs health checks local ASR without contacting local TTS or charging for cloud speech", async () => {
  const config = loadSpeechConfig(credentials);
  let asrReady = true;
  let asrRequests = 0;
  let ttsRequests = 0;
  let cloudRequests = 0;
  const worker = createServer((request, response) => {
    if (request.url === "/v1/models") asrRequests++;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: asrReady ? [{ id: config.asrModel }] : [] }));
  }).listen(0, "127.0.0.1");
  const tts = createServer((_request, response) => { ttsRequests++; response.writeHead(500).end(); }).listen(0, "127.0.0.1");
  await Promise.all([once(worker, "listening"), once(tts, "listening")]);
  const asrAddress = worker.address();
  const ttsAddress = tts.address();
  assert.ok(asrAddress && typeof asrAddress !== "string");
  assert.ok(ttsAddress && typeof ttsAddress !== "string");
  const speech = new Speech({ ...config, asrUrl: `http://127.0.0.1:${asrAddress.port}`, ttsUrl: `http://127.0.0.1:${ttsAddress.port}` }, async () => { cloudRequests++; return pcmResponse(); });
  const gateway = createSpeechServer(speech).listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ready, true);
    const model = body.models.find((entry: { task: string }) => entry.task === "tts");
    assert.equal(model.provider, "elevenlabs");
    assert.equal(model.ready, true);
    assert.equal(model.configured, true);
    assert.equal(model.verified, false);
    assert.doesNotMatch(JSON.stringify(body), /test-private-key/);
    asrReady = false;
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status, 503);
    assert.equal(asrRequests, 2);
    assert.equal(ttsRequests, 0);
    assert.equal(cloudRequests, 0);
  } finally {
    for (const server of [gateway, worker, tts]) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});
