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
  const expandedScores = new Set();
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
  let voiceCatalog = null;
  let loadingVoices = true;
  let voiceCatalogError = false;
  let renderedVoiceOptions = "";
  const voicePreferences = new Map();
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
    if (session?.id !== next.id) expandedScores.clear();
    session = next;
    const index = session.messages.findLastIndex(message => message.role === "assistant");
    const key = index < 0 ? "" : `${session.id}:${index}`;
    const fresh = key && key !== lastAssistantKey;
    // A reconciliation can see committed text before its evaluation finishes.
    // Leave that reply unread until the whole turn becomes active.
    if (!readReply || session.status !== "generating_judgment") lastAssistantKey = key;
    if (readReply && fresh && activeScreen === "debate" && session.status === "active" && !session.pending &&
      !voiceState.capturing && !voiceState.transcribing && $("read-debate-replies").checked) {
      voiceError();
      void voice.play(session.messages[index].text, selectedVoiceId());
    }
  }

  const { node, renderSpeakerCards } = globalThis.DebateUI;
  function conciseComment(value) {
    const text = String(value || "").trim().replace(/\s+/gu, " ");
    const firstSentence = text.match(/^.*?[.!?](?=\s|$)/u)?.[0] || text;
    return firstSentence.length <= 180 ? firstSentence : `${firstSentence.slice(0, 177).trimEnd()}…`;
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
  function voiceSpeaker() {
    return session?.speaker?.name || speakers.find(speaker => speaker.id === speakerId)?.speakerName || "";
  }
  function voicePreferenceKey() {
    return `${voiceCatalog?.provider || ""}:${voiceSpeaker().trim().replace(/\s+/gu, " ").toLowerCase()}`;
  }
  function selectedVoiceId() {
    if (!voiceCatalog) return undefined;
    const key = voicePreferenceKey();
    if (!voicePreferences.has(key)) {
      let stored;
      try { stored = localStorage.getItem(`debate-voice:${key}`); } catch { /* Browser storage is optional. */ }
      voicePreferences.set(key, stored || "");
    }
    const name = voiceSpeaker().trim().replace(/\s+/gu, " ").toLowerCase();
    const preferred = voicePreferences.get(key) || voiceCatalog.speakerDefaults?.[name] || voiceCatalog.defaultVoiceId;
    return voiceCatalog.voices.some(item => item.id === preferred) ? preferred : voiceCatalog.defaultVoiceId;
  }
  function renderVoiceChoice() {
    const select = $("debate-voice");
    const options = voiceCatalog?.voices || [];
    const signature = JSON.stringify([options, loadingVoices]);
    if (signature !== renderedVoiceOptions) {
      renderedVoiceOptions = signature;
      select.replaceChildren();
      for (const item of options) {
        const option = node("option", item.name); option.value = item.id; select.append(option);
      }
      if (!options.length) {
        const fallback = node("option", loadingVoices ? "Loading voices…" : "Service default"); fallback.value = ""; select.append(fallback);
      }
    }
    select.value = selectedVoiceId() || "";
    select.disabled = loadingVoices || !options.length || !voiceSpeaker();
    $("refresh-voices").disabled = loadingVoices;
    $("debate-voice-hint").textContent = voiceCatalogError
      ? "Voice options could not be loaded. Playback uses the service default. Refresh voices to try again."
      : voiceSpeaker() ? `Playback voice for ${voiceSpeaker()}. Saved in this browser; this is a synthetic voice.`
        : "Choose a speaker to set their playback voice. Your choice is saved in this browser.";
  }
  async function loadVoices() {
    loadingVoices = true;
    renderVoiceChoice();
    try {
      const catalog = await request("/api/speech/voices");
      if (!catalog || !["local", "elevenlabs"].includes(catalog.provider) || typeof catalog.defaultVoiceId !== "string" ||
        !Array.isArray(catalog.voices) || !catalog.voices.length || catalog.voices.some(item => !item || typeof item.id !== "string" || typeof item.name !== "string") ||
        !catalog.voices.some(item => item.id === catalog.defaultVoiceId)) throw new Error("Invalid voice catalog");
      voiceCatalog = catalog;
      voiceCatalogError = false;
    } catch { voiceCatalog = null; voiceCatalogError = true; }
    finally { loadingVoices = false; renderVoiceChoice(); }
  }
  function generationPhase() {
    if (ending) return "Ending the debate";
    if (generationAction === "judge" || session?.status === "generating_judgment") return "Judging the speech text";
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
      : elapsed >= 45 ? "The model is still working. Generation and judging can each take up to two minutes. You can end the debate to cancel."
        : "Waiting for the model’s complete response. Generation and judging can each take up to two minutes; you can end the debate to cancel.";
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
  const request = (path, body) => globalThis.DebateUI.request(path, body, "The debate request failed.");
  function renderSpeakers() {
    renderSpeakerCards({ container: $("speaker-options"), speakers, selectedId: speakerId, name: "debate-speaker",
      onChange(id) { speakerId = id; renderState(); } });
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
    } catch (failure) {
      if (version !== speakerLoad) return;
      if (!speakers.length) {
        $("speaker-options").replaceChildren(node("p", "Could not load personas. Select Refresh to try again.", "hint"));
        $("speaker-empty").hidden = true;
      }
      error(`Could not load speaker personas. ${failure.message}`);
    }
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
    renderVoiceChoice();
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
    const status = ending ? "Ending the debate…" : waiting ? `${generationPhase()}… Generation and judging can each take up to two minutes.` :
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
    const judgingDisabled = waiting || recordingBusy || uncertain || ended || pending || session?.status !== "active";
    for (const button of document.querySelectorAll(".retry-debate-judgment")) button.disabled = judgingDisabled;
    if (!positions) return;
    $("debate-opponent").textContent = `SIMULATED OPPONENT · ${session.speaker.name}`;
    $("debate-motion").textContent = positions.motion;
    $("debate-model-label").hidden = !session.model;
    $("debate-model-label").textContent = session.model ? `Model: ${session.model.name}` : "";
    $("affirmative-position").textContent = positions.affirmative;
    $("negative-position").textContent = positions.negative;
    $("debate-source-note").textContent = `Persona: ${session.speaker.name}. Your opponent uses the saved persona’s speaking style, vocabulary and debate habits. The persona stays fixed for this debate.`;
    if (session.humanSide) $("debate-assignments").textContent = `You: ${session.humanSide} · ${positions[session.humanSide]}\n${session.speaker.name} (simulation): ${session.assistantSide} · ${positions[session.assistantSide]}`;
    const judging = session.status === "generating_judgment";
    const key = `${session.id}:${JSON.stringify(session.messages.map(message => [message.judgment, message.judgmentError]))}:${judging}`;
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
          replay.addEventListener("click", () => { voiceError(); void voice.play(message.text, selectedVoiceId()); });
          row.append(replay);
        }
        if (message.judgment) {
          const judgment = message.judgment;
          const evaluation = node("section", undefined, "speech-judgment");
          evaluation.setAttribute("aria-label", `Judgment for turn ${index + 1}`);
          const preview = node("div", undefined, "speech-score-summary");
          const score = node("h4", `${judgment.score}/100`, "speech-score");
          score.setAttribute("aria-label", `Speech score: ${judgment.score} out of 100`);
          preview.append(score, node("p", conciseComment(judgment.rationale), "speech-score-comment"));
          evaluation.append(preview);
          const details = node("details", undefined, "speech-score-details");
          const detailKey = `${session.id}:${index}`;
          details.open = expandedScores.has(detailKey);
          details.addEventListener("toggle", () => {
            if (details.open) expandedScores.add(detailKey);
            else expandedScores.delete(detailKey);
          });
          details.append(node("summary", "Score breakdown"));
          const subcriteria = [["clarity", "Clarity"], ["reasoning", "Reasoning"], ["engagement", "Engagement"]];
          if (subcriteria.every(([name]) => judgment.breakdown?.[name])) {
            for (const [name, label] of subcriteria) {
              const result = judgment.breakdown[name];
              const criterion = node("div", undefined, "speech-criterion");
              const heading = node("div", undefined, "speech-criterion-heading");
              heading.append(node("strong", label), node("span", `${result.score}/100`));
              criterion.append(heading, node("p", result.comment));
              details.append(criterion);
            }
            details.append(node("p", "Each criterion has equal weight. The overall score is their rounded average.", "speech-score-note"));
          } else {
            details.append(node("p", "Detailed scores are unavailable for this earlier evaluation.", "speech-score-note"));
            details.append(node("p", judgment.rationale));
          }
          const criteria = judgment.criteria || "Provisional assessment of clarity, reasoning and engagement.";
          details.append(node("p", /provisional/i.test(criteria) ? criteria : `Provisional criteria: ${criteria}`, "speech-score-note"));
          evaluation.append(details);
          row.append(evaluation);
        } else if (message.judgmentError) {
          const evaluation = node("section", undefined, "speech-judgment");
          evaluation.append(node("h4", "Speech judgment unavailable"), node("p", message.judgmentError));
          const retry = node("button", "Retry judging", "retry-debate-judgment");
          retry.type = "button";
          retry.disabled = judgingDisabled;
          retry.setAttribute("aria-label", `Retry judging ${message.role === "human" ? "your" : "assistant"} speech, turn ${index + 1}`);
          retry.addEventListener("click", () => { void act("judge", { messageIndex: String(index) }); });
          evaluation.append(retry);
          row.append(evaluation);
        } else if (judging) {
          row.append(node("p", "Judging this speech…", "speech-judgment-pending"));
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
  function watchSession(id, version) {
    let watching = true;
    let timer;
    const poll = async () => {
      if (!watching || version !== operation || pageLeaving) return;
      try {
        const result = await request(`/api/debates/${id}`);
        if (!watching || version !== operation || pageLeaving) return;
        acceptSession(result, true); remember(); renderState();
      } catch { /* The action response or explicit reconciliation handles failures. */ }
      if (watching && version === operation && !pageLeaving) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 1500);
    return () => { watching = false; clearTimeout(timer); };
  }
  async function act(action, body = {}) {
    if (!session || (busy && action !== "end")) return;
    if (action === "respond" && (session.pending || session.status !== "active" || uncertain || voiceState.capturing || voiceState.transcribing)) return;
    if (action === "retry" && (voiceState.capturing || voiceState.transcribing)) return;
    if (action === "judge" && (session.pending || session.status !== "active" || uncertain || voiceState.capturing || voiceState.transcribing)) return;
    const contribution = action === "respond" ? body.contribution : action === "retry" && session.pending?.kind === "reply" ? session.pending.contribution : null;
    const submittedDraft = contribution === null ? null : {
      sessionId: session.id, messageIndex: session.messages.length, contribution,
      text: $("debate-argument").value, revision: draftRevision,
    };
    recordedDraft = null;
    voice.cancel(); voiceError();
    const version = ++operation;
    busy = true; ending = action === "end"; generationAction = action; generationStartedAt = Date.now(); error(); renderState();
    const stopWatching = action === "end" ? () => {} : watchSession(session.id, version);
    try {
      const result = await request(`/api/debates/${session.id}/${action}`, body);
      stopWatching();
      if (version !== operation) return;
      acceptSession(result, true); uncertain = false; remember();
    } catch (failure) {
      stopWatching();
      if (version !== operation) return;
      if (failure.session) { acceptSession(failure.session, true); uncertain = false; remember(); }
      else {
        // Reconcile after an interrupted connection before allowing another turn.
        try { await reconcile(session.id, version); }
        catch { if (version === operation) uncertain = true; }
      }
      if (version === operation) error(uncertain ? `${failure.message} Refresh the debate to confirm its state before continuing.` : failure.message);
    } finally {
      stopWatching();
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
  $("debate-voice").addEventListener("change", () => {
    const choice = $("debate-voice").value;
    if (!voiceCatalog?.voices.some(item => item.id === choice)) return;
    voice.stopPlayback();
    const key = voicePreferenceKey();
    voicePreferences.set(key, choice);
    try { localStorage.setItem(`debate-voice:${key}`, choice); } catch { /* Browser storage is optional. */ }
    voiceError();
    renderVoiceChoice();
  });
  $("refresh-voices").addEventListener("click", () => { voice.stopPlayback(); void loadVoices(); });
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
    await Promise.all([loadSpeakers(), loadModels(), loadVoices()]);
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
