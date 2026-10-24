import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface VoiceState {
  recording: boolean; capturing: boolean; transcribing: boolean;
  speaking: boolean; supported: boolean; needsPlaybackGesture: boolean; status: string;
  inputLevel: number | null; inputMonitoring: boolean; microphoneLabel: string; microphoneMuted: boolean;
  captureElapsedSeconds: number; inputSignalDetected: boolean;
}
interface VoiceController {
  startRecording(options?: { deviceId?: string }): Promise<boolean>;
  stopRecording(): void;
  stopPlayback(): void;
  resumePlayback(): Promise<boolean>;
  cancel(): void;
  play(text: string): Promise<boolean>;
  readonly state: VoiceState;
}

function deferred<T>() {
  let complete!: (value: T) => void;
  const promise = new Promise<T>(resolve => { complete = resolve; });
  return { promise, complete };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function harness() {
  const timeline: string[] = [];
  const requests: { path: string; init: RequestInit }[] = [];
  const revoked: string[] = [];
  const sources: string[] = [];
  const timers = new Map<number, { callback: () => void; milliseconds: number }>();
  const playbackStarted = deferred<void>();
  const control = { microphoneStops: 0, finalBlob: new Blob(["final"]), autoEnd: true, blockPlayback: false,
    inputAmplitude: 0, now: 0, monitorSuspended: false, blockMonitor: false, closedContexts: 0, disconnectedSources: 0, disconnectedAnalysers: 0 };
  const microphoneRequests: unknown[] = [];
  const trackEvents = new Map<string, Set<() => void>>();
  const track = {
    label: "Test microphone", muted: false, enabled: true, readyState: "live",
    stop: () => { control.microphoneStops++; },
    addEventListener: (name: string, listener: () => void) => { if (!trackEvents.has(name)) trackEvents.set(name, new Set()); trackEvents.get(name)!.add(listener); },
    removeEventListener: (name: string, listener: () => void) => { trackEvents.get(name)?.delete(listener); },
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const recorders: FakeRecorder[] = [];
  const players: FakeAudio[] = [];
  let nextTimer = 0;
  let nextUrl = 0;
  let receive = async (path: string, _init: RequestInit): Promise<Response> => path.endsWith("transcriptions") ?
    Response.json({ text: "Education should be available to everyone." }) :
    new Response(new Blob(["waveform"], { type: "audio/wav" }));

  class FakeRecorder {
    static isTypeSupported(type: string): boolean { return type === "audio/webm;codecs=opus"; }
    state = "inactive";
    readonly mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void | Promise<void>) | null = null;
    onerror: (() => void) | null = null;
    constructor(_stream: typeof stream, options?: { mimeType: string }) {
      this.mimeType = options?.mimeType ?? "audio/webm";
      recorders.push(this);
    }
    start(_milliseconds: number): void { this.state = "recording"; }
    stop(): void {
      this.state = "inactive";
      queueMicrotask(() => { this.emit(control.finalBlob); void this.onstop?.(); });
    }
    emit(data: Blob): void { this.ondataavailable?.({ data }); }
  }

  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    paused = false;
    private source = "";
    constructor(src = "") { players.push(this); if (src) this.src = src; }
    get src(): string { return this.source; }
    set src(value: string) { this.source = value; if (value) sources.push(value); }
    async play(): Promise<void> {
      timeline.push("play");
      playbackStarted.complete();
      if (control.blockPlayback) throw Object.assign(new Error("Autoplay blocked"), { name: "NotAllowedError" });
      if (control.autoEnd) setImmediate(() => this.finish());
    }
    finish(): void { timeline.push("ended"); this.onended?.(); }
    pause(): void { this.paused = true; }
    removeAttribute(name: string): void { if (name === "src") this.source = ""; }
    load(): void {}
  }

  class FakeAudioContext {
    state = control.monitorSuspended ? "suspended" : "running";
    createMediaStreamSource(_stream: typeof stream) {
      return { connect() {}, disconnect() { control.disconnectedSources++; } };
    }
    createAnalyser() {
      return {
        fftSize: 1024,
        getFloatTimeDomainData(samples: Float32Array) {
          for (let index = 0; index < samples.length; index++) samples[index] = control.inputAmplitude * Math.sin(index * Math.PI / 16);
        },
        disconnect() { control.disconnectedAnalysers++; },
      };
    }
    async resume() { if (control.blockMonitor) throw new Error("Monitoring blocked"); this.state = "running"; }
    async close() { this.state = "closed"; control.closedContexts++; }
  }

  const environment = {
    navigator: { mediaDevices: { getUserMedia: async (constraints?: unknown) => { microphoneRequests.push(constraints); return stream; } } },
    MediaRecorder: FakeRecorder,
    AudioContext: undefined as typeof FakeAudioContext | undefined,
    Date: { now: () => control.now },
    Audio: FakeAudio,
    Blob,
    AbortController,
    URL: { createObjectURL: (_blob: Blob) => `blob:voice-${++nextUrl}`, revokeObjectURL: (url: string) => { revoked.push(url); } },
    setTimeout: (callback: () => void, milliseconds: number) => { const id = ++nextTimer; timers.set(id, { callback, milliseconds }); return id; },
    clearTimeout: (id: number | null) => { if (id !== null) timers.delete(id); },
    fetch: async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      timeline.push(`fetch:${path}`);
      return receive(path, init);
    },
  };
  return {
    environment, stream, control, recorders, players, requests, timeline, revoked, sources, timers, playbackStarted: playbackStarted.promise,
    track, trackEvents, microphoneRequests,
    enableMonitoring() { environment.AudioContext = FakeAudioContext; },
    tickInput(milliseconds = 100) {
      control.now += milliseconds;
      const timer = [...timers.entries()].find(([, value]) => value.milliseconds === 100);
      assert.ok(timer, "an input-monitor timer should be active");
      timers.delete(timer[0]); timer[1].callback();
    },
    emitTrack(name: string) { for (const listener of trackEvents.get(name) ?? []) listener(); },
    receive: (handler: typeof receive) => { receive = handler; },
  };
}

type VoiceOptions = {
  environment: ReturnType<typeof harness>["environment"];
  onState?: (state: VoiceState) => void;
  onTranscript?: (text: string) => void;
  onError?: (message: string) => void;
};
const source = await readFile(resolve("web/debate-speech.js"), "utf8");
const voice = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as {
  splitSpeechText(text: string, limit?: number): string[];
  createDebateSpeech(options: VoiceOptions): VoiceController;
};

test("speech chunking keeps the full response within the synthesis limit", () => {
  const text = `${"Evidence matters. Consider the costs and the alternatives! ".repeat(24)} ${"x".repeat(700)} ${"😀".repeat(170)} End of the response.`;
  const chunks = voice.splitSpeechText(text);
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every(chunk => chunk.length > 0 && chunk.length <= 300));
  assert.equal(chunks.join("").replace(/\s/gu, ""), text.replace(/\s/gu, ""));
  assert.ok(chunks.at(-1)?.endsWith("End of the response."));
  assert.ok(chunks.every(chunk => !/[\uD800-\uDBFF]$/u.test(chunk) && !/^[\uDC00-\uDFFF]/u.test(chunk)));
  assert.deepEqual(voice.splitSpeechText(" \n "), []);
});

test("recording includes its final audio event before transcription and releases the microphone", { timeout: 2000 }, async () => {
  const h = harness();
  const transcript = deferred<string>();
  const controller = voice.createDebateSpeech({ environment: h.environment, onTranscript: transcript.complete });
  assert.equal(await controller.startRecording(), true);
  assert.equal(controller.state.recording, true);
  h.recorders[0]!.emit(new Blob(["first-"]));
  controller.stopRecording();
  assert.equal(await transcript.promise, "Education should be available to everyone.");
  await flush();
  const upload = h.requests.find(request => request.path.endsWith("transcriptions"));
  assert.ok(upload?.init.body instanceof Blob);
  assert.equal(await upload.init.body.text(), "first-final");
  assert.equal(upload.init.body.type, "audio/webm;codecs=opus");
  assert.equal(h.control.microphoneStops, 1);
  assert.equal(controller.state.transcribing, false);
  assert.equal(h.timers.size, 0);
});

test("microphone denial leaves typing available and late permission after cancel releases tracks", async () => {
  const denied = harness();
  denied.environment.navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error("Denied"), { name: "NotAllowedError" }); };
  const errors: string[] = [];
  const refused = voice.createDebateSpeech({ environment: denied.environment, onError: message => errors.push(message) });
  assert.equal(await refused.startRecording(), false);
  assert.match(errors[0]!, /denied.*type/i);
  assert.equal(refused.state.capturing, false);

  const late = harness();
  const permission = deferred<typeof late.stream>();
  late.environment.navigator.mediaDevices.getUserMedia = () => permission.promise;
  const controller = voice.createDebateSpeech({ environment: late.environment });
  const starting = controller.startRecording();
  controller.cancel();
  permission.complete(late.stream);
  assert.equal(await starting, false);
  assert.equal(late.control.microphoneStops, 1);
  assert.equal(late.recorders.length, 0);
  assert.equal(controller.state.capturing, false);
});

test("canceling transcription ignores a late service response", { timeout: 2000 }, async () => {
  const h = harness();
  const response = deferred<Response>();
  const requested = deferred<void>();
  h.receive(async () => { requested.complete(); return response.promise; });
  const transcripts: string[] = [];
  const controller = voice.createDebateSpeech({ environment: h.environment, onTranscript: text => transcripts.push(text) });
  await controller.startRecording();
  controller.stopRecording();
  await requested.promise;
  controller.cancel();
  assert.equal(h.requests[0]!.init.signal?.aborted, true);
  assert.equal(h.timers.size, 0);
  response.complete(Response.json({ text: "This stale result must not replace the draft." }));
  await flush();
  assert.deepEqual(transcripts, []);
  assert.equal(controller.state.transcribing, false);
  assert.equal(h.control.microphoneStops, 1);
});

test("recording uses MP4 when WebM is unsupported and exposes an empty transcription", { timeout: 2000 }, async () => {
  const h = harness();
  h.environment.MediaRecorder.isTypeSupported = type => type === "audio/mp4";
  h.receive(async () => Response.json({ text: "  " }));
  const failure = deferred<string>();
  const controller = voice.createDebateSpeech({ environment: h.environment, onError: failure.complete });
  await controller.startRecording();
  controller.stopRecording();
  assert.match(await failure.promise, /No speech was recognized/);
  await flush();
  assert.equal((h.requests[0]!.init.body as Blob).type, "audio/mp4");
  assert.equal(h.control.microphoneStops, 1);
  assert.equal(controller.state.transcribing, false);
});

test("canceling an in-flight synthesis ignores its eventual audio", { timeout: 2000 }, async () => {
  const h = harness();
  const response = deferred<Response>();
  const requested = deferred<void>();
  h.receive(async () => { requested.complete(); return response.promise; });
  const controller = voice.createDebateSpeech({ environment: h.environment });
  const playing = controller.play("This response is no longer current.");
  await requested.promise;
  controller.stopPlayback();
  assert.equal(h.requests[0]!.init.signal?.aborted, true);
  response.complete(new Response(new Blob(["late waveform"], { type: "audio/wav" })));
  assert.equal(await playing, false);
  assert.equal(h.timeline.filter(event => event === "play").length, 0);
  assert.equal(controller.state.speaking, false);
  assert.equal(h.timers.size, 0);
});

test("recording duration and progressive byte limits release microphone resources", { timeout: 2000 }, async () => {
  const timed = harness();
  const transcript = deferred<string>();
  const controller = voice.createDebateSpeech({ environment: timed.environment, onTranscript: transcript.complete });
  await controller.startRecording();
  const duration = [...timed.timers.values()].find(timer => timer.milliseconds === 115000);
  assert.ok(duration);
  duration.callback();
  await transcript.promise;
  assert.equal(timed.control.microphoneStops, 1);
  assert.equal(controller.state.recording, false);

  const oversized = harness();
  const errors: string[] = [];
  const limited = voice.createDebateSpeech({ environment: oversized.environment, onError: message => errors.push(message) });
  await limited.startRecording();
  oversized.recorders[0]!.emit(new Blob([new Uint8Array(16 * 1024 * 1024 + 1)]));
  await flush();
  assert.equal(oversized.control.microphoneStops, 1);
  assert.equal(oversized.requests.length, 0);
  assert.match(errors[0]!, /16 MiB/);
  assert.equal(limited.state.capturing, false);
  assert.equal(oversized.timers.size, 0);
});

test("long responses synthesize and play all passages serially without prefetch", { timeout: 2000 }, async () => {
  const h = harness();
  const controller = voice.createDebateSpeech({ environment: h.environment });
  const text = "Consider the evidence before reaching a conclusion. ".repeat(18);
  assert.equal(await controller.play(text), true);
  const requests = h.requests.filter(request => request.path.endsWith("/audio"));
  assert.equal(requests.length, voice.splitSpeechText(text).length);
  const spoken = requests.map(request => (JSON.parse(request.init.body as string) as { input: string }).input);
  assert.equal(spoken.join("").replace(/\s/gu, ""), text.replace(/\s/gu, ""));
  for (let index = 1; index < requests.length; index++) {
    assert.equal(h.timeline[index * 3 - 1], "ended");
    assert.equal(h.timeline[index * 3], "fetch:/api/speech/audio");
  }
  assert.equal(h.revoked.length, requests.length);
  assert.equal(h.players.length, 1);
  assert.equal(h.sources.length, requests.length);
  assert.equal(controller.state.speaking, false);
  assert.equal(h.timers.size, 0);
});

test("stopping playback settles pending playback and revokes its audio URL", { timeout: 2000 }, async () => {
  const h = harness();
  h.control.autoEnd = false;
  const controller = voice.createDebateSpeech({ environment: h.environment });
  const playing = controller.play("An argument worth hearing.");
  await h.playbackStarted;
  assert.equal(h.players.length, 1);
  controller.stopPlayback();
  assert.equal(await playing, false);
  assert.equal(h.players[0]!.paused, true);
  assert.deepEqual(h.revoked, ["blob:voice-1"]);
  assert.equal(controller.state.speaking, false);
  assert.equal(h.timers.size, 0);
});

test("blocked autoplay resumes the loaded passage synchronously without resynthesis", { timeout: 2000 }, async () => {
  const h = harness();
  h.control.blockPlayback = true;
  const blocked = deferred<void>();
  const controller = voice.createDebateSpeech({ environment: h.environment, onState: state => { if (state.needsPlaybackGesture) blocked.complete(); } });
  const text = "Please hear this argument before reaching a conclusion. ".repeat(15);
  const playing = controller.play(text);
  await blocked.promise;
  assert.equal(controller.state.needsPlaybackGesture, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.sources.length, 1);
  assert.equal(h.revoked.length, 0);
  const before = h.timeline.length;
  h.control.blockPlayback = false;
  const resumed = controller.resumePlayback();
  assert.equal(h.timeline[before], "play", "Audio.play must run in the resume click's synchronous stack");
  assert.equal(await resumed, true);
  assert.equal(await playing, true);
  const chunks = voice.splitSpeechText(text);
  assert.equal(h.requests.length, chunks.length);
  assert.equal(h.sources.length, chunks.length);
  assert.equal(h.players.length, 1);
  assert.equal(h.revoked.length, chunks.length);
  assert.equal(controller.state.needsPlaybackGesture, false);
});

test("stopping while waiting for a playback gesture releases the pending passage", { timeout: 2000 }, async () => {
  const h = harness();
  h.control.blockPlayback = true;
  const blocked = deferred<void>();
  const controller = voice.createDebateSpeech({ environment: h.environment, onState: state => { if (state.needsPlaybackGesture) blocked.complete(); } });
  const playing = controller.play("An argument waiting for your playback permission.");
  await blocked.promise;
  controller.stopPlayback();
  assert.equal(await playing, false);
  assert.deepEqual(h.revoked, ["blob:voice-1"]);
  assert.equal(controller.state.needsPlaybackGesture, false);
  assert.equal(controller.state.speaking, false);
  assert.equal(h.timers.size, 0);
});

test("separate assistant responses reuse the same audio element", { timeout: 2000 }, async () => {
  const h = harness();
  const controller = voice.createDebateSpeech({ environment: h.environment });
  assert.equal(await controller.play("The opening argument."), true);
  assert.equal(await controller.play("The follow-up argument."), true);
  assert.equal(h.players.length, 1);
  assert.equal(h.sources.length, 2);
  assert.equal(h.revoked.length, 2);
});

test("late completion of canceled audio cannot clear or finish a newer response", { timeout: 2000 }, async () => {
  const h = harness();
  h.control.autoEnd = false;
  const secondStarted = deferred<void>();
  const controller = voice.createDebateSpeech({ environment: h.environment, onState: state => {
    if (state.speaking && h.sources.length === 2) secondStarted.complete();
  } });
  const first = controller.play("The previous response.");
  await h.playbackStarted;
  const staleEnded = h.players[0]!.onended;
  assert.ok(staleEnded);
  const second = controller.play("The current response.");
  await secondStarted.promise;
  assert.equal(await first, false);
  assert.equal(h.players[0]!.src, "blob:voice-2");
  assert.deepEqual(h.revoked, ["blob:voice-1"]);
  staleEnded();
  await flush();
  assert.equal(controller.state.speaking, true);
  assert.equal(h.players[0]!.src, "blob:voice-2");
  h.players[0]!.finish();
  assert.equal(await second, true);
  assert.deepEqual(h.revoked, ["blob:voice-1", "blob:voice-2"]);
});

test("microphone diagnostics measure real input, expose the selected track and release monitoring resources", async () => {
  const h = harness();
  h.enableMonitoring(); h.control.inputAmplitude = 0.25;
  const controller = voice.createDebateSpeech({ environment: h.environment });
  assert.equal(await controller.startRecording({ deviceId: "chosen-input" }), true);
  assert.deepEqual(h.microphoneRequests[0], { audio: {
    channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, deviceId: { exact: "chosen-input" },
  } });
  assert.equal(controller.state.microphoneLabel, "Test microphone");
  assert.equal(controller.state.inputMonitoring, true);
  assert.ok(Math.abs(controller.state.inputLevel! - 0.25 / Math.sqrt(2)) < 0.0001);
  assert.equal(controller.state.inputSignalDetected, true);
  h.tickInput(1200);
  assert.equal(controller.state.captureElapsedSeconds, 1);
  controller.cancel();
  assert.equal(controller.state.inputLevel, null);
  assert.equal(controller.state.inputMonitoring, false);
  assert.equal(h.control.closedContexts, 1);
  assert.equal(h.control.disconnectedSources, 1);
  assert.equal(h.control.disconnectedAnalysers, 1);
  assert.equal(h.control.microphoneStops, 1);
  assert.equal(h.timers.size, 0);
  assert.ok([...h.trackEvents.values()].every(listeners => listeners.size === 0));
});

test("empty recognition distinguishes measured silence from audible input without blaming the spoken language", async () => {
  for (const amplitude of [0, 0.2]) {
    const h = harness();
    h.enableMonitoring(); h.control.inputAmplitude = amplitude;
    h.receive(async () => Response.json({ text: "" }));
    const failed = deferred<string>();
    const controller = voice.createDebateSpeech({ environment: h.environment, onError: failed.complete });
    await controller.startRecording();
    for (let index = 0; index < 12; index++) h.tickInput();
    controller.stopRecording();
    const error = await failed.promise;
    if (amplitude === 0) assert.match(error, /recording was silent/);
    else { assert.match(error, /No speech was recognized/); assert.doesNotMatch(error, /silent|muted|English|language/i); }
    await flush();
    assert.equal(h.requests.length, 1, "even a silent recording reaches transcription instead of relying on a speech detector");
    assert.equal(h.control.closedContexts, 1);
    assert.equal(h.timers.size, 0);
  }
});

test("an unavailable audio meter never prevents recording or transcription and does not invent a level", async () => {
  const h = harness();
  h.enableMonitoring(); h.control.monitorSuspended = true; h.control.blockMonitor = true;
  const transcript = deferred<string>();
  const controller = voice.createDebateSpeech({ environment: h.environment, onTranscript: transcript.complete });
  assert.equal(await controller.startRecording(), true);
  await flush(); h.tickInput(1100);
  assert.equal(controller.state.inputLevel, null);
  assert.equal(controller.state.inputMonitoring, false);
  assert.equal(controller.state.inputSignalDetected, false);
  assert.equal(controller.state.captureElapsedSeconds, 1);
  controller.stopRecording();
  assert.equal(await transcript.promise, "Education should be available to everyone.");
  await flush();
  assert.equal(h.control.closedContexts, 1);
  assert.equal(h.timers.size, 0);
});

test("muted and disconnected microphone tracks produce actionable warnings and release listeners", async () => {
  const h = harness();
  const errors: string[] = [];
  const controller = voice.createDebateSpeech({ environment: h.environment, onError: message => errors.push(message) });
  await controller.startRecording();
  h.track.muted = true; h.emitTrack("mute");
  assert.equal(controller.state.microphoneMuted, true);
  assert.match(controller.state.status, /microphone is muted/);
  h.track.muted = false; h.emitTrack("unmute");
  assert.equal(controller.state.microphoneMuted, false);
  assert.match(controller.state.status, /Recording your argument/);
  h.track.readyState = "ended"; h.emitTrack("ended");
  await flush();
  assert.match(errors[0]!, /microphone disconnected/);
  assert.equal(h.control.microphoneStops, 1);
  assert.equal(controller.state.recording, false);
  assert.equal(h.timers.size, 0);
  assert.ok([...h.trackEvents.values()].every(listeners => listeners.size === 0));
});
