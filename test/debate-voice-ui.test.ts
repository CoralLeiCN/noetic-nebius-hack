import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import type { Snapshot } from "../src/debate.js";

interface UiEvent { preventDefault(): void; detail?: unknown }
type Listener = (event: UiEvent) => void | Promise<void>;

class UiElement {
  value = "";
  textContent = "";
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  tagName = "";
  required = false;
  type = "";
  name = "";
  label = "";
  id = "";
  className = "";
  scrollTop = 0;
  scrollHeight = 0;
  dataset: Record<string, string> = {};
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

function deferred<T>() {
  let complete!: (result: T) => void;
  const promise = new Promise<T>(resolve => { complete = resolve; });
  return { promise, complete };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function failedSession(kind: "reply" | "opening"): Snapshot {
  return {
    id: "00000000-0000-4000-8000-000000000001", status: kind === "reply" ? "active" : "positions_ready",
    topic: "Public transport", positions: { motion: "Cities should remove fares.", affirmative: "Free fares widen access.", negative: "Fares fund service." },
    humanSide: "affirmative", assistantSide: "negative",
    pending: kind === "reply" ? { kind, contribution: "The submitted argument." } : { kind, side: "affirmative" },
    messages: kind === "reply" ? [{ role: "assistant", text: "How should we fund the service?" }] : [],
    speaker: { personaId: "speaker-1", name: "Alex", personaMarkdown: "Alex explains tradeoffs in public transport." },
    model: { id: "deepseek-ai/test", name: "Test model", family: "DeepSeek" },
  };
}

async function ui(initial: Snapshot, preferences = new Map<string, string>(), catalogFails = false, personasFail = false, authored = false) {
  let now = 0;
  let timerSequence = 0;
  const timers = new Map<number, { due: number; delay: number; callback: () => void }>();
  const setTimer = (callback: () => void, delay = 0) => {
    const id = ++timerSequence;
    timers.set(id, { due: now + delay, delay, callback });
    return id;
  };
  const clearTimer = (id: number) => { timers.delete(id); };
  class UiDate extends Date { static override now() { return now; } }
  const html = await readFile(resolve("web/index.html"), "utf8");
  const elements = new Map<string, UiElement>();
  const created: UiElement[] = [];
  for (const match of html.matchAll(/id="([^"]+)"/gu)) {
    const element = new UiElement(); element.id = match[1]!; elements.set(element.id, element);
  }
  function element(id: string): UiElement {
    const found = elements.get(id);
    assert.ok(found, `The real HTML must provide #${id}`);
    return found;
  }
  const screens = ["debate", "library", "arena"].map(screen => { const result = new UiElement(); result.dataset.screen = screen; return result; });
  const sides = ["affirmative", "negative"].map(side => { const result = new UiElement(); result.dataset.side = side; return result; });
  const documentEvents = new Map<string, Listener[]>();
  const windowEvents = new Map<string, Listener[]>();
  const storage = new Map([["debate-session", initial.id], ["debate-read-replies", "false"]]);
  const voiceState = { recording: false, capturing: false, transcribing: false, speaking: false, supported: true, needsPlaybackGesture: false, status: "", inputLevel: null as number | null, microphoneLabel: "", microphoneMuted: false, inputMonitoring: false, inputSignalDetected: false, captureElapsedSeconds: 0 };
  let callbacks!: { onState(state: typeof voiceState): void; onTranscript(text: string): void; onError(message: string): void };
  let canceled = 0;
  let stoppedPlayback = 0;
  const playback: { text: string; voiceId: string | undefined }[] = [];
  let recordingOptions: { deviceId?: string } | undefined;
  const voice = {
    get state() { return { ...voiceState }; },
    async startRecording(options?: { deviceId?: string }) { recordingOptions = options; Object.assign(voiceState, { recording: true, capturing: true }); callbacks.onState({ ...voiceState }); return true; },
    stopRecording() { Object.assign(voiceState, { recording: false, capturing: false, transcribing: true }); callbacks.onState({ ...voiceState }); },
    cancel() { canceled++; Object.assign(voiceState, { recording: false, capturing: false, transcribing: false, speaking: false }); callbacks.onState({ ...voiceState }); },
    stopPlayback() { stoppedPlayback++; }, async resumePlayback() { return true; }, async play(text: string, voiceId?: string) { playback.push({ text, voiceId }); return true; },
  };
  let snapshot = structuredClone(initial);
  const requests: { path: string; body: Record<string, string> | null }[] = [];
  let retryResponse: (() => Promise<Response>) | null = null;
  let judgeResponse: (() => Promise<Response>) | null = null;
  let sessionResponse: (() => Promise<Response>) | null = null;
  const fetch = async (path: string, options?: { body: string }): Promise<Response> => {
    const body = options ? JSON.parse(options.body) as Record<string, string> : null;
    requests.push({ path, body });
    if (path === "/api/personas") return personasFail
      ? Response.json({ error: "Saved persona does not match its manifest." }, { status: 500 })
      : Response.json([{ id: initial.speaker!.personaId, speakerName: initial.speaker!.name, sourceCount: authored ? 0 : 1, ...(authored ? { kind: "authored" } : {}) }, { id: "speaker-2", speakerName: "Morgan", sourceCount: 1 }]);
    if (path === "/api/speech/voices") return catalogFails ? Response.json({ error: "Unavailable" }, { status: 503 }) : Response.json({
      provider: "elevenlabs", defaultVoiceId: "default-voice", voices: [{ id: "default-voice", name: "Default voice" }, { id: "6osMNatXqZrKCuGTB2bV", name: "The Rising Reformer" }],
      speakerDefaults: { "andy burnham": "6osMNatXqZrKCuGTB2bV" },
    });
    if (path === "/api/models") return Response.json({ models: [initial.model], defaultModel: initial.model!.id });
    if (path === `/api/debates/${initial.id}`) return sessionResponse ? sessionResponse() : Response.json(snapshot);
    if (path.endsWith("/judge") && judgeResponse) return judgeResponse();
    if (path.endsWith("/retry")) {
      if (retryResponse) return retryResponse();
      const pending = snapshot.pending;
      snapshot = { ...snapshot, status: "active", pending: null, messages: [...snapshot.messages,
        ...(pending?.kind === "reply" ? [{ role: "human" as const, text: pending.contribution }] : []),
        { role: "assistant", text: "The recovered response." }] };
      return Response.json(snapshot);
    }
    if (path.endsWith("/respond")) {
      snapshot = { ...snapshot, messages: [...snapshot.messages, { role: "human", text: body!.contribution! }, { role: "assistant", text: "A new response." }] };
      return Response.json(snapshot);
    }
    if (path.endsWith("/end")) { snapshot = { ...snapshot, status: "ended" }; return Response.json(snapshot); }
    throw new Error(`Unexpected request ${path}`);
  };
  const source = await readFile(resolve("web/debate.js"), "utf8");
  const importLine = 'import { createDebateSpeech } from "./debate-speech.js";';
  assert.ok(source.startsWith(importLine));
  runInNewContext(source.replace(importLine, ""), {
    document: {
      getElementById: element,
      createElement: (tag: string) => { const result = new UiElement(); result.tagName = tag; created.push(result); return result; },
      querySelectorAll: (selector: string) => selector === "[data-screen]" ? screens : selector === "[data-side]" ? sides :
        selector === "[data-side], #regenerate-debate" ? [...sides, element("regenerate-debate")] :
          selector.startsWith(".") ? created.filter(item => item.className === selector.slice(1)) : [],
      addEventListener: (name: string, listener: Listener) => documentEvents.set(name, [...documentEvents.get(name) ?? [], listener]),
      dispatchEvent: (event: { type: string; detail: unknown }) => { for (const listener of documentEvents.get(event.type) ?? []) void listener({ preventDefault() {}, detail: event.detail }); },
    },
    window: { addEventListener: (name: string, listener: Listener) => windowEvents.set(name, [...windowEvents.get(name) ?? [], listener]) },
    navigator: { mediaDevices: { enumerateDevices: async () => [{ kind: "audioinput", deviceId: "usb-mic", label: "USB microphone" }] } },
    localStorage: { getItem: (name: string) => preferences.get(name) ?? null, setItem: (name: string, value: string) => preferences.set(name, value) },
    sessionStorage: { getItem: (name: string) => storage.get(name) ?? null, setItem: (name: string, value: string) => storage.set(name, value), removeItem: (name: string) => storage.delete(name) },
    CustomEvent: class { constructor(readonly type: string, readonly options: { detail: unknown }) {} get detail() { return this.options.detail; } },
    createDebateSpeech: (options: typeof callbacks) => { callbacks = options; return voice; },
    fetch, setTimeout: setTimer, clearTimeout: clearTimer, Date: UiDate, console,
  }, { filename: "web/debate.js" });
  await flush();
  return {
    element, requests, screens, playback,
    recoverPersonas() { personasFail = false; },
    get stoppedPlayback() { return stoppedPlayback; },
    replay() { const button = created.find(item => item.className === "replay-debate-reply"); assert.ok(button); button.emit("click"); },
    chooseSpeaker(id: string) { for (const listener of documentEvents.get("choose-debate-speaker") ?? []) void listener({ preventDefault() {}, detail: id }); },
    get canceled() { return canceled; },
    get played() { return playback.length; },
    get recordingOptions() { return recordingOptions; },
    inputState(state: Partial<typeof voiceState>) { Object.assign(voiceState, state); callbacks.onState({ ...voiceState }); },
    draft(text: string) { element("debate-argument").value = text; element("debate-argument").emit("input"); },
    transcript(text: string) { callbacks.onTranscript(text); Object.assign(voiceState, { recording: false, capturing: false, transcribing: false }); callbacks.onState({ ...voiceState }); },
    retry(handler: () => Promise<Response>) { retryResponse = handler; },
    judge(handler: () => Promise<Response>) { judgeResponse = handler; },
    sessionRead(handler: () => Promise<Response>) { sessionResponse = handler; },
    current() { return structuredClone(snapshot); },
    pagehide() { for (const listener of windowEvents.get("pagehide") ?? []) void listener({ preventDefault() {} }); },
    progressTimers() { return [...timers.values()].filter(timer => timer.delay === 1000).length; },
    async advance(milliseconds: number) {
      const target = now + milliseconds;
      let ticks = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        assert.ok(++ticks < 1000, "The UI clock must not create an unbounded timer loop");
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

test("persona list failure replaces the loading state and Refresh recovers", async () => {
  const app = await ui(failedSession("reply"), new Map(), false, true);
  assert.match(app.element("speaker-options").children[0]!.textContent, /Could not load personas.*Refresh/);
  assert.equal(app.element("speaker-empty").hidden, true);
  assert.match(app.element("debate-error").textContent, /Saved persona does not match its manifest/);
  assert.equal(app.element("refresh-speakers").disabled, false);
  app.recoverPersonas();
  app.element("refresh-speakers").emit("click");
  await flush();
  assert.equal(app.element("speaker-options").children.length, 2);
  assert.equal(app.element("speaker-options").children[0]!.className, "speaker-card");
  assert.equal(app.element("debate-error").hidden, true);
});

test("Practice identifies an authored persona without presenting nonexistent video sources", async () => {
  const snapshot = failedSession("reply");
  snapshot.speaker!.name = "Socrates";
  const app = await ui(snapshot, new Map(), false, false, true);
  const label = app.element("speaker-options").children[0]!;
  assert.equal(label.children[1]!.children[0]!.textContent, "Socrates");
  assert.equal(label.children[1]!.children[1]!.textContent, "Authored persona");
  assert.equal(label.children[0]!.checked, true);
});

for (const kind of ["opening", "reply"] as const) test(`failed ${kind} keeps speech and draft available with explicit recovery`, async () => {
  const app = await ui(failedSession(kind));
  assert.equal(app.element("record-debate-argument").disabled, false);
  assert.equal(app.element("debate-argument").disabled, false);
  assert.equal(app.element("send-argument").disabled, true);
  assert.equal(app.element("retry-debate-input").hidden, false);
  assert.match(app.element("debate-input-status").textContent, /retry/i);
  app.draft("My next point.");
  app.element("record-debate-argument").emit("click");
  assert.equal(app.element("send-argument").disabled, true);
  app.element("record-debate-argument").emit("click");
  app.transcript("Public transport widens access.");
  assert.equal(app.element("debate-argument").value, "My next point.\nPublic transport widens access.");
  assert.equal(app.element("retry-debate-input").disabled, false);
  app.element("retry-debate-input").emit("click");
  await flush();
  assert.equal(app.element("debate-argument").value, "My next point.\nPublic transport widens access.");
  assert.equal(app.element("send-argument").disabled, false);
  assert.equal(app.requests.filter(request => request.path.endsWith("/respond")).length, 0, "Retry must not submit the newly recorded draft");
});

test("reply retry submits the frozen contribution once and preserves a new recorded draft for the next turn", async () => {
  const app = await ui(failedSession("reply"));
  app.draft("The next argument.");
  app.element("record-debate-argument").emit("click");
  app.element("record-debate-argument").emit("click");
  app.transcript("A more reliable service helps everyone.");
  const draft = app.element("debate-argument").value;
  app.element("retry-debate-input").emit("click");
  await flush();
  app.element("argument-form").emit("submit");
  await flush();
  const requests = app.requests.filter(request => request.body);
  assert.deepEqual(requests.map(request => request.path.split("/").at(-1)), ["retry", "respond"]);
  assert.equal(requests[1]!.body!.contribution, draft);
  assert.equal(app.current().messages.filter(message => message.text === "The submitted argument.").length, 1);
  assert.equal(app.element("debate-argument").value, "");
});

test("retry clears only the unchanged submitted draft and does not erase a later edit", async () => {
  const unchanged = await ui(failedSession("reply"));
  unchanged.draft("The submitted argument.");
  unchanged.element("retry-debate-input").emit("click");
  await flush();
  assert.equal(unchanged.element("debate-argument").value, "");

  const changed = await ui(failedSession("reply"));
  changed.draft("The submitted argument.");
  const pending = deferred<Response>();
  changed.retry(() => pending.promise);
  changed.element("retry-debate-input").emit("click");
  assert.equal(changed.element("record-debate-argument").disabled, true);
  changed.draft("A later draft must survive.");
  pending.complete(Response.json({ ...changed.current(), pending: null, status: "active" }));
  await flush();
  assert.equal(changed.element("debate-argument").value, "A later draft must survive.");
});

test("uncertain and ended sessions still disable speech; navigation cancels capture", async () => {
  const uncertain = await ui(failedSession("reply"));
  uncertain.retry(async () => { throw new Error("Connection interrupted"); });
  uncertain.sessionRead(async () => { throw new Error("Still disconnected"); });
  uncertain.element("retry-debate-input").emit("click");
  await flush();
  assert.equal(uncertain.element("record-debate-argument").disabled, true);
  assert.equal(uncertain.element("send-argument").disabled, true);
  assert.match(uncertain.element("debate-status").textContent, /reconnect|refresh/i);

  const app = await ui(failedSession("reply"));
  app.element("record-debate-argument").emit("click");
  const before = app.canceled;
  app.screens[1]!.emit("click");
  assert.ok(app.canceled > before);
  app.screens[0]!.emit("click");
  app.element("record-debate-argument").emit("click");
  const beforeArena = app.canceled;
  app.screens[2]!.emit("click");
  assert.ok(app.canceled > beforeArena);
  assert.equal(app.element("arena-screen").hidden, false);
  assert.equal(app.element("debate-screen").hidden, true);
  app.screens[0]!.emit("click");
  app.element("end-debate").emit("click");
  await flush();
  assert.equal(app.element("record-debate-argument").disabled, true);
  assert.equal(app.element("argument-form").hidden, true);
});

for (const kind of ["opening", "reply"] as const) test(`pending ${kind} retry shows elapsed progress until success`, async () => {
  const app = await ui(failedSession(kind));
  const response = deferred<Response>();
  app.retry(() => response.promise);
  app.element("retry-debate-input").emit("click");
  assert.equal(app.element("debate-generation-progress").hidden, false);
  assert.match(app.element("debate-generation-phase").textContent, kind === "opening" ? /Retrying:.*opening/ : /Retrying:.*response/);
  assert.equal(app.element("debate-generation-elapsed").textContent, "0s elapsed");
  assert.equal(app.element("debate-messages").attributes.get("aria-busy"), "true");
  assert.equal(app.progressTimers(), 1);
  const announcement = app.element("debate-status").textContent;
  await app.advance(45_000);
  assert.equal(app.element("debate-generation-elapsed").textContent, "45s elapsed");
  assert.match(app.element("debate-generation-hint").textContent, /still working.*two minutes/i);
  assert.equal(app.element("debate-status").textContent, announcement, "Elapsed ticks must not rewrite the live status");
  await app.advance(75_000);
  assert.match(app.element("debate-generation-hint").textContent, /finish or time out/i);
  response.complete(Response.json({ ...app.current(), status: "active", pending: null }));
  await flush();
  assert.equal(app.element("debate-generation-progress").hidden, true);
  assert.equal(app.element("debate-messages").attributes.get("aria-busy"), "false");
  assert.equal(app.progressTimers(), 0);
  assert.equal(app.element("send-argument").disabled, false);
});

test("failed retry replaces waiting progress with recovery and releases its timer", async () => {
  const app = await ui(failedSession("opening"));
  const response = deferred<Response>();
  app.retry(() => response.promise);
  app.element("retry-debate-input").emit("click");
  await app.advance(3000);
  response.complete(Response.json({ error: "The provider is unavailable.", session: app.current() }, { status: 503 }));
  await flush();
  assert.equal(app.element("debate-generation-progress").hidden, true);
  assert.equal(app.progressTimers(), 0);
  assert.match(app.element("debate-error").textContent, /provider is unavailable/);
  assert.equal(app.element("retry-debate-input").hidden, false);
  assert.equal(app.element("record-debate-argument").disabled, false);
});

test("navigation and page exit stop progress ticks while returning shows elapsed waiting time", async () => {
  const app = await ui(failedSession("opening"));
  const response = deferred<Response>();
  app.retry(() => response.promise);
  app.element("retry-debate-input").emit("click");
  app.screens[1]!.emit("click");
  assert.equal(app.element("debate-generation-progress").hidden, true);
  assert.equal(app.progressTimers(), 0);
  await app.advance(5000);
  app.screens[0]!.emit("click");
  assert.equal(app.element("debate-generation-progress").hidden, false);
  assert.equal(app.element("debate-generation-elapsed").textContent, "5s elapsed");
  assert.equal(app.progressTimers(), 1);
  app.pagehide();
  assert.equal(app.progressTimers(), 0);
  response.complete(Response.json({ ...app.current(), status: "active", pending: null }));
  await flush();
  assert.equal(app.progressTimers(), 0);
});

test("restored generation shows the opening phase and stops when reconciliation finishes", async () => {
  const app = await ui({ ...failedSession("opening"), status: "generating_opening" });
  assert.equal(app.element("debate-generation-progress").hidden, false);
  assert.match(app.element("debate-generation-phase").textContent, /Writing the assistant’s opening/);
  assert.equal(app.element("record-debate-argument").disabled, true);
  assert.equal(app.progressTimers(), 1);
  await app.advance(1000);
  assert.equal(app.element("debate-generation-elapsed").textContent, "1s elapsed");
  app.sessionRead(async () => Response.json({ ...app.current(), status: "active", pending: null }));
  await app.advance(500);
  assert.equal(app.element("debate-generation-progress").hidden, true);
  assert.equal(app.progressTimers(), 0);
  assert.equal(app.element("record-debate-argument").disabled, false);
});

test("microphone selection reaches capture and real input diagnostics stay visible while recording", async () => {
  const app = await ui(failedSession("opening"));
  assert.equal(app.element("debate-microphone").children.some(option => option.value === "usb-mic"), true);
  app.element("debate-microphone").value = "usb-mic";
  app.element("record-debate-argument").emit("click");
  assert.equal(app.recordingOptions?.deviceId, "usb-mic");
  app.inputState({ inputLevel: 0.03, microphoneLabel: "USB microphone", inputMonitoring: true, inputSignalDetected: true, captureElapsedSeconds: 4 });
  assert.equal(app.element("debate-microphone").disabled, true);
  assert.equal(app.element("debate-input-monitor").hidden, false);
  assert.equal(app.element("debate-input-level").hidden, false);
  assert.match(app.element("debate-input-detail").textContent, /USB microphone.*4s recorded.*Sound detected/);
  app.inputState({ microphoneMuted: true });
  assert.match(app.element("debate-input-detail").textContent, /muted or unavailable/);
  app.element("cancel-debate-recording").emit("click");
  assert.equal(app.element("debate-input-monitor").hidden, true);
  assert.equal(app.element("debate-microphone").disabled, false);
});


test("Andy uses The Rising Reformer; explicit voice selection survives reload and applies to replay", async () => {
  const initial = failedSession("reply");
  initial.speaker = { ...initial.speaker!, name: "Andy Burnham" };
  const preferences = new Map<string, string>();
  const app = await ui(initial, preferences);
  assert.equal(app.element("debate-voice").value, "6osMNatXqZrKCuGTB2bV");
  assert.equal(app.element("debate-voice").disabled, false);
  app.replay();
  assert.equal(app.playback[0]!.voiceId, "6osMNatXqZrKCuGTB2bV");
  const before = app.stoppedPlayback;
  app.element("debate-voice").value = "default-voice";
  app.element("debate-voice").emit("change");
  assert.equal(app.stoppedPlayback, before + 1);
  assert.equal(app.playback.length, 1, "changing voice must not synthesize audio");
  app.replay();
  assert.equal(app.playback[1]!.voiceId, "default-voice");
  const reloaded = await ui(initial, preferences);
  assert.equal(reloaded.element("debate-voice").value, "default-voice");
  reloaded.element("read-debate-replies").checked = true;
  reloaded.element("retry-debate-input").emit("click");
  await flush();
  assert.equal(reloaded.playback[0]!.voiceId, "default-voice", "autoplay uses the saved voice too");
});

test("voice choices belong to each speaker and current-session replay keeps its speaker", async () => {
  const initial = failedSession("reply");
  initial.speaker = { ...initial.speaker!, name: "Andy Burnham" };
  const app = await ui(initial);
  app.chooseSpeaker("speaker-2");
  assert.equal(app.element("debate-voice").value, "6osMNatXqZrKCuGTB2bV", "an active debate keeps Andy's voice");
  app.element("end-debate").emit("click");
  await flush();
  app.chooseSpeaker("speaker-2");
  assert.equal(app.element("debate-voice").value, "default-voice");
  app.element("debate-voice").value = "6osMNatXqZrKCuGTB2bV";
  app.element("debate-voice").emit("change");
  app.chooseSpeaker("speaker-1");
  assert.equal(app.element("debate-voice").value, "6osMNatXqZrKCuGTB2bV");
  app.element("debate-voice").value = "default-voice";
  app.element("debate-voice").emit("change");
  app.chooseSpeaker("speaker-2");
  assert.equal(app.element("debate-voice").value, "6osMNatXqZrKCuGTB2bV");
});

test("voice catalog failures preserve playback with the service default", async () => {
  const app = await ui(failedSession("reply"), new Map(), true);
  assert.equal(app.element("debate-voice").disabled, true);
  assert.match(app.element("debate-voice-hint").textContent, /could not be loaded/);
  app.replay();
  assert.equal(app.playback[0]!.voiceId, undefined);
});

const speechJudgment = {
  score: 78, rationale: "A clear claim; explain how the funding mechanism works.",
  criteria: "Clarity, reasoning and response to opposing arguments.", provisional: true as const,
  breakdown: {
    clarity: { score: 80, comment: "Your position is easy to follow." },
    reasoning: { score: 75, comment: "Explain how the funding reaches services." },
    engagement: { score: 79, comment: "Address the strongest objection directly." },
  },
};
function speechSession(): Snapshot {
  return { ...failedSession("reply"), pending: null, messages: [
    { role: "assistant", text: "How should we fund the service?", judgment: speechJudgment },
    { role: "human", text: "My reviewed speech transcript.", judgmentError: "Judging failed. Retry the evaluation." },
  ] };
}
function descendants(element: UiElement): UiElement[] { return [element, ...element.children.flatMap(descendants)]; }
function renderedText(element: UiElement): string { return descendants(element).map(child => child.textContent).join("\n"); }
function visibleText(element: UiElement): string {
  const children = element.tagName === "details" && !element.open ? element.children.filter(child => child.tagName === "summary") : element.children;
  return [element.textContent, ...children.map(visibleText)].join("\n");
}
function scoreDetails(element: UiElement): UiElement {
  const details = descendants(element).find(child => child.className === "speech-score-details");
  assert.ok(details);
  return details;
}
function judgmentRetry(app: Awaited<ReturnType<typeof ui>>): UiElement {
  const button = descendants(app.element("debate-messages")).find(child => child.className === "retry-debate-judgment");
  assert.ok(button);
  return button;
}

test("speech judgments show both roles and retry updates the same turn without resubmitting or replaying", async () => {
  const initial = speechSession();
  const app = await ui(initial);
  const before = renderedText(app.element("debate-messages"));
  assert.match(before, /78\/100/);
  assert.match(before, /Score breakdown/);
  assert.match(before, /My reviewed speech transcript/);
  assert.match(before, /Speech judgment unavailable/);
  app.draft("My next draft stays here.");
  app.element("read-debate-replies").checked = true;
  const response = deferred<Response>();
  app.judge(() => response.promise);
  judgmentRetry(app).emit("click");
  assert.match(app.element("debate-generation-phase").textContent, /Judging the speech text/);
  assert.equal(judgmentRetry(app).disabled, true);
  response.complete(Response.json({ ...initial, messages: initial.messages.map(message => ({ role: message.role, text: message.text, judgment: speechJudgment })) }));
  await flush();
  const rows = app.element("debate-messages").children;
  assert.equal(rows.length, 2);
  assert.match(renderedText(rows[0]!), /78\/100/);
  assert.match(renderedText(rows[1]!), /78\/100/);
  assert.doesNotMatch(renderedText(rows[1]!), /Retry judging/);
  assert.equal(app.element("debate-argument").value, "My next draft stays here.");
  assert.equal(app.played, 0);
  assert.deepEqual(app.requests.filter(request => request.body), [{ path: `/api/debates/${initial.id}/judge`, body: { messageIndex: "1" } }]);
});

test("score cards show a concise preview and expand into every criterion's score and comment", async () => {
  const app = await ui(speechSession());
  const row = app.element("debate-messages").children[0]!;
  const evaluation = descendants(row).find(element => element.className === "speech-judgment")!;
  const details = scoreDetails(evaluation);
  assert.equal(details.open, false);
  assert.match(visibleText(evaluation), /78\/100/);
  assert.match(visibleText(evaluation), /A clear claim; explain how the funding mechanism works\./);
  assert.doesNotMatch(visibleText(evaluation), /Speech score|Provisional|Clarity|Reasoning|Engagement|equal weight/);
  assert.equal(details.children[0]!.tagName, "summary");
  assert.equal(details.children[0]!.textContent, "Score breakdown");
  details.open = true;
  details.emit("toggle");
  for (const [name, result] of Object.entries(speechJudgment.breakdown)) {
    assert.match(visibleText(evaluation), new RegExp(name, "i"));
    assert.ok(visibleText(evaluation).includes(`${result.score}/100`));
    assert.ok(visibleText(evaluation).includes(result.comment));
  }
  assert.match(visibleText(evaluation), /equal weight.*rounded average/);
  assert.match(visibleText(evaluation), /Provisional criteria/);
});

test("expanded scores stay open when another turn's judgment refreshes", async () => {
  const initial = speechSession();
  const app = await ui(initial);
  const details = scoreDetails(app.element("debate-messages").children[0]!);
  details.open = true;
  details.emit("toggle");
  app.judge(async () => Response.json({ ...initial, messages: initial.messages.map(message => ({ role: message.role, text: message.text, judgment: speechJudgment })) }));
  judgmentRetry(app).emit("click");
  await flush();
  assert.equal(scoreDetails(app.element("debate-messages").children[0]!).open, true);
  assert.equal(scoreDetails(app.element("debate-messages").children[1]!).open, false);
});

test("earlier evaluations keep comments brief without inventing missing subcriteria", async () => {
  const { breakdown: _breakdown, ...legacy } = speechJudgment;
  legacy.rationale = "Your claim is clear. " + "This earlier evaluation contains a much longer explanation. ".repeat(8);
  const initial = { ...speechSession(), messages: [{ role: "assistant", text: "Earlier speech", judgment: legacy }] } as unknown as Snapshot;
  const app = await ui(initial);
  const evaluation = descendants(app.element("debate-messages")).find(element => element.className === "speech-judgment")!;
  assert.match(visibleText(evaluation), /Your claim is clear\./);
  assert.doesNotMatch(visibleText(evaluation), /much longer explanation/);
  const details = scoreDetails(evaluation);
  details.open = true;
  assert.match(visibleText(details), /Detailed scores are unavailable for this earlier evaluation/);
  assert.ok(visibleText(details).includes(legacy.rationale));
  assert.equal(descendants(details).filter(element => element.className === "speech-criterion").length, 0);
});

test("earlier comments without sentence boundaries are bounded in the collapsed card", async () => {
  const { breakdown: _breakdown, ...legacy } = speechJudgment;
  legacy.rationale = "A long comment ".repeat(30);
  const initial = { ...speechSession(), messages: [{ role: "human", text: "Earlier speech", judgment: legacy }] } as unknown as Snapshot;
  const app = await ui(initial);
  const comment = descendants(app.element("debate-messages")).find(element => element.className === "speech-score-comment")!;
  assert.ok(comment.textContent.length <= 180);
  assert.ok(comment.textContent.endsWith("…"));
});

test("judging failure keeps speech feedback retryable and recording or ended sessions disable retry", async () => {
  const initial = speechSession();
  const app = await ui(initial);
  app.element("record-debate-argument").emit("click");
  assert.equal(judgmentRetry(app).disabled, true);
  app.element("cancel-debate-recording").emit("click");
  assert.equal(judgmentRetry(app).disabled, false);
  app.judge(async () => Response.json({ ...initial, messages: [initial.messages[0], { ...initial.messages[1], judgmentError: "Still unavailable. Retry judging." }] }));
  judgmentRetry(app).emit("click");
  await flush();
  assert.match(renderedText(app.element("debate-messages")), /Still unavailable/);
  assert.equal(judgmentRetry(app).disabled, false);
  assert.equal(app.element("send-argument").disabled, false);
  app.element("end-debate").emit("click");
  await flush();
  assert.equal(judgmentRetry(app).disabled, true);
});

test("restored judging displays committed speeches and refreshes evaluations without adding turns", async () => {
  const initial: Snapshot = { ...speechSession(), status: "generating_judgment", messages: [{ role: "human", text: "My reviewed speech transcript." }] };
  const app = await ui(initial);
  assert.match(app.element("debate-generation-phase").textContent, /Judging the speech text/);
  assert.match(renderedText(app.element("debate-messages")), /My reviewed speech transcript/);
  assert.match(renderedText(app.element("debate-messages")), /Judging this speech/);
  app.sessionRead(async () => Response.json({ ...initial, status: "active", messages: [{ ...initial.messages[0], judgment: speechJudgment }] }));
  await app.advance(1500);
  assert.equal(app.element("debate-messages").children.length, 1);
  assert.match(renderedText(app.element("debate-messages")), /78\/100/);
  assert.equal(app.element("debate-generation-progress").hidden, true);
});

test("an in-flight turn refreshes committed speech and judging progress before the POST completes", async () => {
  const initial = failedSession("opening");
  const app = await ui(initial);
  const response = deferred<Response>();
  app.retry(() => response.promise);
  app.element("read-debate-replies").checked = true;
  app.element("retry-debate-input").emit("click");
  const judging: Snapshot = { ...initial, status: "generating_judgment", pending: null, messages: [{ role: "assistant", text: "The completed opening speech." }] };
  app.sessionRead(async () => Response.json(judging));
  await app.advance(1500);
  assert.match(app.element("debate-generation-phase").textContent, /Judging the speech text/);
  assert.match(renderedText(app.element("debate-messages")), /The completed opening speech/);
  assert.equal(app.played, 0);
  response.complete(Response.json({ ...judging, status: "active", messages: [{ ...judging.messages[0], judgment: speechJudgment }] }));
  await flush();
  assert.match(renderedText(app.element("debate-messages")), /78\/100/);
  assert.equal(app.played, 1);
  assert.equal(app.element("debate-generation-progress").hidden, true);
  const reads = app.requests.filter(request => request.path === `/api/debates/${initial.id}`).length;
  await app.advance(3000);
  assert.equal(app.requests.filter(request => request.path === `/api/debates/${initial.id}`).length, reads, "The completed action must stop polling");
});

test("late progress reads cannot replace the final speech evaluation", async () => {
  const initial = speechSession();
  const app = await ui(initial);
  const response = deferred<Response>();
  const progress = deferred<Response>();
  app.judge(() => response.promise);
  app.sessionRead(() => progress.promise);
  judgmentRetry(app).emit("click");
  await app.advance(1500);
  const completed = { ...initial, messages: initial.messages.map(message => ({ role: message.role, text: message.text, judgment: speechJudgment })) };
  response.complete(Response.json(completed));
  await flush();
  progress.complete(Response.json({ ...initial, status: "generating_judgment" }));
  await flush();
  assert.match(renderedText(app.element("debate-messages").children[1]!), /78\/100/);
  assert.equal(app.element("debate-generation-progress").hidden, true);
});
