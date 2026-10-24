import { createDebateSpeech } from "./debate-speech.js";

(() => {
  const $ = id => document.getElementById(id);
  let speakers = [];
  let speakerId = "";
  let session = null;
  let busy = false;
  let ending = false;
  let uncertain = false;
  let operation = 0;
  let messageKey = "";
  let speakerLoad = 0;
  let models = [];
  let defaultModel = "";
  let modelChoice = "";
  let loadingModels = true;
  let activeScreen = "debate";
  let lastAssistantKey = "";
  let recordedDraft = null;
  let draftRevision = 0;
  let generationAction = "";
  let generationStartedAt = null;
  let generationTimer = null;
  let pageLeaving = false;
  let microphoneLoad = 0;
  let voice = null;
  let voiceState = { recording: false, capturing: false, transcribing: false, speaking: false, supported: false, status: "" };

  function voiceError(message = "") {
    $("debate-speech-error").textContent = message;
    $("debate-speech-error").hidden = !message;
  }
  voice = createDebateSpeech({
    onState(state) { voiceState = state; if (voice) renderState(); },
    onError: voiceError,
    onTranscript(text) {
      if (!recordedDraft || session?.id !== recordedDraft.sessionId || activeScreen !== "debate" || !canDraftArgument()) return;
      const field = $("debate-argument");
      if (field.value !== recordedDraft.text) throw new Error("Your draft changed while transcription ran. Your edits were kept; record again when ready.");
      const combined = [recordedDraft.text.trimEnd(), text].filter(Boolean).join("\n");
      if (combined.length > 12000) throw new Error("The transcript would exceed the 12,000-character argument limit. Shorten your draft before recording again.");
      field.value = combined;
      draftRevision++;
      recordedDraft = null;
    },
  });
  voiceState = voice.state;
  try { $("read-debate-replies").checked = sessionStorage.getItem("debate-read-replies") !== "false"; } catch { /* Speech preferences are optional. */ }

  function acceptSession(next, readReply = false) {
    session = next;
    const index = session.messages.findLastIndex(message => message.role === "assistant");
    const key = index < 0 ? "" : `${session.id}:${index}`;
    const fresh = key && key !== lastAssistantKey;
    lastAssistantKey = key;
    if (readReply && fresh && activeScreen === "debate" && session.status === "active" && !session.pending &&
      !voiceState.capturing && !voiceState.transcribing && $("read-debate-replies").checked) {
      voiceError();
      void voice.play(session.messages[index].text);
    }
  }

  function node(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  }
  function error(message = "") { $("debate-error").textContent = message; $("debate-error").hidden = !message; }
  function canDraftArgument() {
    return Boolean(session?.humanSide && ["active", "positions_ready"].includes(session.status));
  }
  async function loadMicrophones() {
    const media = globalThis.navigator?.mediaDevices;
    if (!media?.enumerateDevices) return;
    const version = ++microphoneLoad;
    try {
      const devices = (await media.enumerateDevices()).filter(device => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default");
      if (version !== microphoneLoad || pageLeaving) return;
      const select = $("debate-microphone");
      const previous = select.value;
      const fallback = node("option", "System default microphone"); fallback.value = "";
      select.replaceChildren(fallback);
      devices.forEach((device, index) => {
        const option = node("option", device.label || `Microphone ${index + 1}`); option.value = device.deviceId; select.append(option);
      });
      select.value = devices.some(device => device.deviceId === previous) ? previous : "";
    } catch { /* A default input still works when device enumeration is unavailable. */ }
  }
  function generationPhase() {
    if (ending) return "Ending the debate";
    if (generationAction === "create") return "Starting your debate";
    if (generationAction === "sync") return "Checking your debate’s latest response";
    const kind = generationAction === "retry" ? session?.pending?.kind :
      generationAction === "prepare" || session?.status === "generating_positions" ? "positions" :
        generationAction === "choose" || session?.status === "generating_opening" ? "opening" : "reply";
    const phase = kind === "positions" ? "Preparing the two positions" : kind === "opening" ? "Writing the assistant’s opening" : "Writing the assistant’s response";
    return generationAction === "retry" ? `Retrying: ${phase.charAt(0).toLowerCase()}${phase.slice(1)}` : phase;
  }
  function stopGenerationTimer() {
    clearTimeout(generationTimer);
    generationTimer = null;
  }
  function renderGenerationProgress(waiting) {
    waiting = Boolean(waiting);
    stopGenerationTimer();
    const visible = waiting && activeScreen === "debate" && !pageLeaving;
    $("debate-generation-progress").hidden = !visible;
    $("debate-messages").setAttribute("aria-busy", String(waiting));
    if (!waiting) { generationStartedAt = null; generationAction = ""; return; }
    generationStartedAt ??= Date.now();
    if (!visible) return;
    const elapsed = Math.max(0, Math.floor((Date.now() - generationStartedAt) / 1000));
    $("debate-generation-phase").textContent = `${generationPhase()}…`;
    $("debate-generation-elapsed").textContent = `${elapsed}s elapsed`;
    $("debate-generation-hint").textContent = ending ? "Please wait while the current generation is canceled." : elapsed >= 120
      ? "Still waiting for the provider to finish or time out. You can end the debate to cancel; your confirmed turns stay visible."
      : elapsed >= 45 ? "The model is still working. Requests can take up to two minutes. You can end the debate to cancel."
        : "Waiting for the model’s complete response. This can take up to two minutes; you can end the debate to cancel.";
    generationTimer = setTimeout(() => renderGenerationProgress(busy || (session?.status.startsWith("generating_") && !uncertain)), 1000);
  }
  function screen(name) {
    activeScreen = name;
    if (name !== "debate") { recordedDraft = null; voice.cancel(); voiceError(); }
    $("debate-screen").hidden = name !== "debate";
    $("library-screen").hidden = name !== "library";
    $("arena-screen").hidden = name !== "arena";
    document.dispatchEvent(new CustomEvent("workspace-screen", { detail: name }));
    for (const button of document.querySelectorAll("[data-screen]")) button.setAttribute("aria-pressed", String(button.dataset.screen === name));
    document.dispatchEvent(new CustomEvent("workspace-screen-changed", { detail: name }));
    renderGenerationProgress(busy || (session?.status.startsWith("generating_") && !uncertain));
  }
  function remember() {
    try {
      if (session) sessionStorage.setItem("debate-session", session.id);
      else sessionStorage.removeItem("debate-session");
    } catch { /* Practice also works with browser storage disabled. */ }
  }
  async function request(path, body) {
    const response = await fetch(path, body === undefined ? undefined : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      const failure = new Error(data.error || "The debate request failed.");
      failure.session = data.session;
      throw failure;
    }
    return data;
  }
  function renderSpeakers() {
    $("speaker-options").replaceChildren();
    for (const speaker of speakers) {
      const label = node("label", undefined, "speaker-card");
      const radio = node("input");
      radio.type = "radio"; radio.name = "debate-speaker"; radio.value = speaker.id;
      radio.checked = speaker.id === speakerId; radio.required = true;
      radio.addEventListener("change", () => { speakerId = speaker.id; renderState(); });
      const copy = node("span");
      copy.append(node("strong", speaker.speakerName), node("small", `Persona · ${speaker.sourceCount} source${speaker.sourceCount === 1 ? "" : "s"}`));
      label.append(radio, copy); $("speaker-options").append(label);
    }
    $("speaker-empty").hidden = Boolean(speakers.length);
    renderState();
  }
  async function loadSpeakers() {
    const version = ++speakerLoad;
    $("refresh-speakers").disabled = true;
    try {
      const records = await request("/api/personas");
      if (version !== speakerLoad) return;
      updateSpeakers(records);
      error();
    } catch (failure) { error(`Could not load speaker personas. ${failure.message}`); }
    finally { $("refresh-speakers").disabled = false; }
  }
  function updateSpeakers(records) {
    speakers = records;
    if (!speakers.some(speaker => speaker.id === speakerId)) speakerId = session?.speaker?.personaId || speakers[0]?.id || "";
    renderSpeakers();
  }
  function renderModels() {
    const select = $("debate-model");
    const chosen = session?.model?.id || modelChoice || defaultModel;
    const options = [...models];
    if (session?.model && !options.some(model => model.id === chosen)) options.push(session.model);
    select.replaceChildren();
    for (const family of new Set(options.map(model => model.family))) {
      const group = node("optgroup"); group.label = family;
      for (const model of options.filter(model => model.family === family)) {
        const option = node("option", model.name); option.value = model.id; group.append(option);
      }
      if (group.children.length) select.append(group);
    }
    if (!options.length) {
      const placeholder = node("option", loadingModels ? "Loading models…" : "No models available");
      placeholder.value = ""; select.append(placeholder);
    }
    select.value = options.some(model => model.id === chosen) ? chosen : options[0]?.id || "";
    if (!session) modelChoice = select.value;
    renderState();
  }
  async function loadModels() {
    if (loadingModels && models.length) return;
    loadingModels = true;
    $("model-error").hidden = true;
    renderState();
    try {
      const catalog = await request("/api/models");
      models = catalog.models; defaultModel = catalog.defaultModel || "";
      if (!models.length) throw new Error("None of the selected practice models are available from the configured provider.");
    } catch (failure) {
      models = [];
      $("model-error").textContent = `Could not load models. ${failure.message}`;
      $("model-error").hidden = false;
    } finally { loadingModels = false; renderModels(); }
  }
  function renderState() {
    const ended = session?.status === "ended";
    const pending = Boolean(session?.pending);
    const positions = session?.positions;
    const generating = session?.status.startsWith("generating_");
    const waiting = busy || (generating && !uncertain);
    const recordingBusy = voiceState.capturing || voiceState.recording || voiceState.transcribing;
    const draftAllowed = canDraftArgument();
    renderGenerationProgress(waiting);
    $("debate-fields").disabled = waiting || Boolean(session);
    $("prepare-debate").disabled = waiting || !speakers.length || loadingModels || !$("debate-model").value;
    $("debate-model").disabled = loadingModels || !models.length;
    $("refresh-models").disabled = loadingModels;
    $("prepare-debate").textContent = busy && !positions ? "Preparing debate…" : "Prepare debate ↗";
    $("review-debate-source").hidden = !(session?.speaker?.personaId || speakerId);
    $("debate-welcome").hidden = Boolean(positions);
    $("debate-detail").hidden = !positions;
    $("debate-badge").textContent = ended ? "ENDED" : uncertain ? "RECONNECT" : waiting ? "GENERATING" : pending ? session.pending.kind === "opening" ? "OPENING FAILED" : session.pending.kind === "reply" ? "REPLY FAILED" : "PREPARATION FAILED" : session?.status === "active" ? "LIVE PRACTICE" : positions ? "CHOOSE A SIDE" : "SETUP";
    $("room-heading").textContent = session?.speaker ? `Debate with ${session.speaker.name}` : "The floor is yours";
    const status = ending ? "Ending the debate…" : waiting ? `${generationPhase()}… This can take up to two minutes.` :
      uncertain ? "Refresh the debate to reconnect and confirm the latest turn." : ended ? "Debate ended. Your transcript is available below until you start a new debate." : pending ? "Generation failed. Retry to continue with the same input." : "";
    if ($("debate-status").textContent !== status) $("debate-status").textContent = status;
    $("sync-debate").hidden = !uncertain || waiting;
    $("retry-debate").hidden = !pending || ended || waiting || uncertain;
    $("retry-debate").disabled = recordingBusy;
    $("end-debate").hidden = !session || ended;
    $("end-debate").disabled = ending;
    $("new-debate").hidden = !ended;
    $("argument-form").hidden = !positions || !session?.humanSide || ended;
    $("debate-argument").disabled = waiting || uncertain || recordingBusy || !draftAllowed;
    $("send-argument").disabled = waiting || pending || uncertain || recordingBusy || session?.status !== "active";
    $("send-argument").textContent = waiting ? "Waiting for your opponent…" : "Send argument →";
    $("side-picker").hidden = !positions || Boolean(session?.humanSide) || ended;
    for (const button of document.querySelectorAll("[data-side], #regenerate-debate")) button.disabled = waiting || pending || uncertain;
    $("debate-assignments").hidden = !session?.humanSide;
    $("debate-voice-controls").hidden = !positions;
    $("stop-debate-audio").hidden = !voiceState.speaking;
    $("play-debate-audio").hidden = !voiceState.needsPlaybackGesture;
    if ($("debate-speech-status").textContent !== voiceState.status) $("debate-speech-status").textContent = voiceState.status;
    $("debate-microphone").disabled = waiting || uncertain || recordingBusy || !draftAllowed || !voiceState.supported;
    $("debate-input-monitor").hidden = !recordingBusy;
    const level = voiceState.inputLevel;
    $("debate-input-level").hidden = typeof level !== "number";
    $("debate-input-level").value = typeof level === "number" && level > 0 ? Math.max(0, Math.min(100, (20 * Math.log10(level) + 60) / 60 * 100)) : 0;
    const signal = voiceState.microphoneMuted ? "Microphone is muted or unavailable" : voiceState.inputSignalDetected ? "Sound detected" : voiceState.inputMonitoring ? "No sound detected yet — check the selected microphone" : "Input level unavailable in this browser";
    $("debate-input-detail").textContent = `${voiceState.microphoneLabel || "Selected microphone"} · ${voiceState.captureElapsedSeconds || 0}s recorded · ${signal}`;
    const microphone = $("record-debate-argument");
    microphone.textContent = voiceState.recording ? "Stop recording" : voiceState.transcribing ? "Transcribing…" : voiceState.capturing ? "Waiting for microphone…" : "Speak argument";
    microphone.setAttribute("aria-pressed", String(voiceState.recording));
    microphone.disabled = !voiceState.supported || waiting || uncertain || !draftAllowed || voiceState.transcribing || (voiceState.capturing && !voiceState.recording);
    $("cancel-debate-recording").hidden = !recordingBusy;
    $("cancel-debate-recording").textContent = voiceState.transcribing ? "Cancel transcription" : "Cancel recording";
    $("debate-recording-hint").textContent = voiceState.supported ? "English transcription. Choose your microphone and check the input meter while speaking. Record up to 115 seconds, then stop, review the text and send." : "Microphone recording is unavailable in this browser. You can still type your argument and listen to replies.";
    $("retry-debate-input").hidden = !pending || !draftAllowed || ended || waiting || uncertain;
    $("retry-debate-input").disabled = recordingBusy;
    $("retry-debate-input").textContent = session?.pending?.kind === "opening" ? "Retry opening" : "Retry assistant response";
    $("debate-input-status").hidden = !pending || !draftAllowed || ended || waiting || uncertain;
    $("debate-input-status").textContent = session?.pending?.kind === "opening"
      ? "The assistant’s opening failed. You can speak or type a draft now. Retry the opening before sending your argument."
      : "The assistant’s reply failed. Your previous argument is saved for retry. You can speak or type your next draft now; retry the reply before sending it.";
    for (const button of document.querySelectorAll(".replay-debate-reply")) button.disabled = waiting || recordingBusy;
    if (!positions) return;
    $("debate-opponent").textContent = `SIMULATED OPPONENT · ${session.speaker.name}`;
    $("debate-motion").textContent = positions.motion;
    $("debate-model-label").hidden = !session.model;
    $("debate-model-label").textContent = session.model ? `Model: ${session.model.name}` : "";
    $("affirmative-position").textContent = positions.affirmative;
    $("negative-position").textContent = positions.negative;
    $("debate-source-note").textContent = `Persona: ${session.speaker.name}. Your opponent uses the saved persona’s speaking style, vocabulary and debate habits. The persona stays fixed for this debate.`;
    if (session.humanSide) $("debate-assignments").textContent = `You: ${session.humanSide} · ${positions[session.humanSide]}\n${session.speaker.name} (simulation): ${session.assistantSide} · ${positions[session.assistantSide]}`;
    const key = `${session.id}:${session.messages.length}`;
    if (messageKey !== key) {
      messageKey = key;
      $("debate-messages").replaceChildren();
      for (const [index, message] of session.messages.entries()) {
        const row = node("article", undefined, `debate-message ${message.role}`);
        row.append(node("h3", message.role === "human" ? "YOU" : `${session.speaker.name.toUpperCase()} · SIMULATION`), node("p", message.text));
        if (message.role === "assistant") {
          const replay = node("button", "Replay response", "replay-debate-reply");
          replay.type = "button";
          replay.disabled = waiting || recordingBusy;
          replay.setAttribute("aria-label", `Replay assistant response, turn ${index + 1}`);
          replay.addEventListener("click", () => { voiceError(); void voice.play(message.text); });
          row.append(replay);
        }
        row.setAttribute("aria-label", `Turn ${index + 1}`);
        $("debate-messages").append(row);
      }
      $("debate-messages").scrollTop = $("debate-messages").scrollHeight;
    }
  }
  async function reconcile(id, version) {
    do {
      const result = await request(`/api/debates/${id}`);
      if (version !== operation) return;
      acceptSession(result, true); uncertain = false; remember(); renderState();
      if (!session.status.startsWith("generating_")) return;
      await new Promise(resolve => setTimeout(resolve, 1500));
    } while (version === operation);
  }
  async function act(action, body = {}) {
    if (!session || (busy && action !== "end")) return;
    if (action === "respond" && (session.pending || session.status !== "active" || uncertain || voiceState.capturing || voiceState.transcribing)) return;
    if (action === "retry" && (voiceState.capturing || voiceState.transcribing)) return;
    const contribution = action === "respond" ? body.contribution : action === "retry" && session.pending?.kind === "reply" ? session.pending.contribution : null;
    const submittedDraft = contribution === null ? null : {
      sessionId: session.id, messageIndex: session.messages.length, contribution,
      text: $("debate-argument").value, revision: draftRevision,
    };
    recordedDraft = null;
    voice.cancel(); voiceError();
    const version = ++operation;
    busy = true; ending = action === "end"; generationAction = action; generationStartedAt = Date.now(); error(); renderState();
    try {
      const result = await request(`/api/debates/${session.id}/${action}`, body);
      if (version !== operation) return;
      acceptSession(result, true); uncertain = false; remember();
    } catch (failure) {
      if (version !== operation) return;
      if (failure.session) { acceptSession(failure.session, true); uncertain = false; remember(); }
      else {
        // Reconcile after an interrupted connection before allowing another turn.
        try { await reconcile(session.id, version); }
        catch { if (version === operation) uncertain = true; }
      }
      if (version === operation) error(uncertain ? `${failure.message} Refresh the debate to confirm its state before continuing.` : failure.message);
    } finally {
      if (version === operation) {
        const committed = submittedDraft && session?.messages[submittedDraft.messageIndex];
        if (submittedDraft && session?.id === submittedDraft.sessionId && session.status === "active" && !session.pending &&
          committed?.role === "human" && committed.text === submittedDraft.contribution &&
          draftRevision === submittedDraft.revision && $("debate-argument").value === submittedDraft.text && submittedDraft.text.trim() === submittedDraft.contribution) {
          $("debate-argument").value = "";
          draftRevision++;
        }
        busy = false; ending = false; renderState();
        if (session?.status === "active" && !session.pending) $("debate-argument").focus({ preventScroll: true });
      }
    }
  }
  $("debate-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !speakerId || loadingModels || !$("debate-model").value) return;
    const topic = $("debate-topic").value.trim();
    if (!topic) return;
    busy = true; generationAction = "create"; generationStartedAt = Date.now(); error(); renderState();
    try {
      acceptSession(await request("/api/debates", { speakerId, model: $("debate-model").value })); remember();
    } catch (failure) { error(failure.message); }
    finally { busy = false; renderState(); }
    if (session && session.status === "topic_entry") await act("prepare", { topic });
  });
  for (const button of document.querySelectorAll("[data-side]")) button.addEventListener("click", () => { void act("choose", { side: button.dataset.side }); });
  for (const button of document.querySelectorAll("[data-screen]")) button.addEventListener("click", () => screen(button.dataset.screen));
  $("argument-form").addEventListener("submit", event => {
    event.preventDefault();
    const contribution = $("debate-argument").value.trim();
    if (contribution) void act("respond", { contribution });
  });
  $("debate-argument").addEventListener("input", () => { draftRevision++; });
  $("record-debate-argument").addEventListener("click", () => {
    if (voiceState.recording) { voice.stopRecording(); return; }
    if (busy || uncertain || !canDraftArgument() || activeScreen !== "debate" || voiceState.capturing || voiceState.transcribing) return;
    voiceError();
    recordedDraft = { sessionId: session.id, text: $("debate-argument").value };
    void voice.startRecording({ deviceId: $("debate-microphone").value }).then(started => { if (started) void loadMicrophones(); });
  });
  $("cancel-debate-recording").addEventListener("click", () => { recordedDraft = null; voice.cancel(); voiceError(); });
  $("stop-debate-audio").addEventListener("click", () => voice.stopPlayback());
  $("play-debate-audio").addEventListener("click", () => { voiceError(); void voice.resumePlayback(); });
  $("read-debate-replies").addEventListener("change", () => {
    if (!$("read-debate-replies").checked) voice.stopPlayback();
    try { sessionStorage.setItem("debate-read-replies", String($("read-debate-replies").checked)); } catch { /* Speech preferences are optional. */ }
  });
  $("regenerate-debate").addEventListener("click", () => { void act("prepare", { topic: session.topic }); });
  $("retry-debate").addEventListener("click", () => { void act("retry"); });
  $("retry-debate-input").addEventListener("click", () => { void act("retry"); });
  $("end-debate").addEventListener("click", () => { void act("end"); });
  $("new-debate").addEventListener("click", () => { ++operation; recordedDraft = null; voice.cancel(); voiceError(); session = null; lastAssistantKey = ""; uncertain = false; messageKey = ""; $("debate-argument").value = ""; remember(); error(); renderModels(); $("debate-topic").focus(); });
  $("refresh-models").addEventListener("click", () => { void loadModels(); });
  $("debate-model").addEventListener("change", () => {
    modelChoice = $("debate-model").value;
    try { sessionStorage.setItem("debate-model", modelChoice); } catch { /* Storage is optional. */ }
    renderState();
  });
  $("sync-debate").addEventListener("click", async () => {
    if (!session || busy) return;
    const version = ++operation;
    busy = true; generationAction = "sync"; generationStartedAt = Date.now(); error(); renderState();
    try { await reconcile(session.id, version); }
    catch (failure) { error(failure.message); }
    finally { if (version === operation) { busy = false; renderState(); } }
  });
  $("refresh-speakers").addEventListener("click", () => { void loadSpeakers(); });
  $("add-speaker").addEventListener("click", () => { screen("library"); $("speakerName").focus(); });
  $("review-debate-source").addEventListener("click", () => {
    screen("library");
    document.dispatchEvent(new CustomEvent("review-speaker-persona", { detail: session?.speaker?.personaId || speakerId }));
  });
  document.addEventListener("personas-updated", event => updateSpeakers(event.detail));
  document.addEventListener("choose-debate-speaker", event => {
    screen("debate");
    if (session && session.status !== "ended") {
      error("End the current debate and start a new one to change speakers."); return;
    }
    ++operation; recordedDraft = null; voice.cancel(); voiceError(); session = null; lastAssistantKey = ""; uncertain = false; speakerId = event.detail; $("debate-argument").value = ""; remember(); error(); renderSpeakers(); renderModels(); $("debate-topic").focus();
  });
  async function initialize() {
    let id;
    try { id = sessionStorage.getItem("debate-session"); modelChoice = sessionStorage.getItem("debate-model") || ""; } catch { /* Storage is optional. */ }
    if (id) {
      busy = true; generationAction = "sync"; renderState();
      try {
        acceptSession(await request(`/api/debates/${encodeURIComponent(id)}`));
        speakerId = session.speaker?.personaId || "";
        $("debate-topic").value = session.topic || session.pending?.topic || "";
      } catch { session = null; remember(); error("Your previous debate is no longer available. Start a new one."); }
      finally { busy = false; generationAction = ""; }
    }
    await Promise.all([loadSpeakers(), loadModels()]);
    // A page reload may happen while the server is finishing a generation.
    if (session?.status.startsWith("generating_")) {
      const version = operation;
      try { await reconcile(session.id, version); }
      catch (failure) { if (version === operation) { uncertain = true; error(failure.message); } }
    }
    renderState();
  }
  window.addEventListener("pagehide", () => { pageLeaving = true; recordedDraft = null; voice.cancel(); stopGenerationTimer(); });
  window.addEventListener("pageshow", () => { pageLeaving = false; renderState(); });
  globalThis.navigator?.mediaDevices?.addEventListener?.("devicechange", () => { void loadMicrophones(); });
  void loadMicrophones();
  void initialize();
})();
