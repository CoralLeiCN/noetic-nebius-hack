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

  function node(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  }
  function error(message = "") { $("debate-error").textContent = message; $("debate-error").hidden = !message; }
  function screen(name) {
    $("debate-screen").hidden = name !== "debate";
    $("library-screen").hidden = name !== "library";
    for (const button of document.querySelectorAll("[data-screen]")) button.setAttribute("aria-pressed", String(button.dataset.screen === name));
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
      copy.append(node("strong", speaker.speakerName), node("small", speaker.title));
      label.append(radio, copy); $("speaker-options").append(label);
    }
    $("speaker-empty").hidden = Boolean(speakers.length);
    renderState();
  }
  async function loadSpeakers() {
    const version = ++speakerLoad;
    $("refresh-speakers").disabled = true;
    try {
      const records = await request("/api/videos");
      if (version !== speakerLoad) return;
      updateSpeakers(records);
      error();
    } catch (failure) { error(`Could not load ready speakers. ${failure.message}`); }
    finally { $("refresh-speakers").disabled = false; }
  }
  function updateSpeakers(records) {
    speakers = records;
    if (!speakers.some(speaker => speaker.id === speakerId)) speakerId = session?.speaker?.recordId || speakers[0]?.id || "";
    renderSpeakers();
  }
  function renderModels() {
    const select = $("debate-model");
    const chosen = session?.model?.id || modelChoice || defaultModel;
    const options = [...models];
    if (session?.model && !options.some(model => model.id === chosen)) options.push(session.model);
    select.replaceChildren();
    for (const family of ["DeepSeek", "MiniMax", "Configured"]) {
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
      if (!models.length) throw new Error("No DeepSeek or MiniMax models are available from the configured provider.");
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
    $("debate-fields").disabled = waiting || Boolean(session);
    $("prepare-debate").disabled = waiting || !speakers.length || loadingModels || !$("debate-model").value;
    $("debate-model").disabled = loadingModels || !models.length;
    $("refresh-models").disabled = loadingModels;
    $("prepare-debate").textContent = busy && !positions ? "Preparing debate…" : "Prepare debate ↗";
    $("review-debate-source").hidden = !(session?.speaker?.recordId || speakerId);
    $("debate-welcome").hidden = Boolean(positions);
    $("debate-detail").hidden = !positions;
    $("debate-badge").textContent = ended ? "ENDED" : uncertain ? "RECONNECT" : waiting ? "GENERATING" : session?.status === "active" ? "LIVE PRACTICE" : positions ? "CHOOSE A SIDE" : "SETUP";
    $("room-heading").textContent = session?.speaker ? `Debate with ${session.speaker.name}` : "The floor is yours";
    $("debate-status").textContent = ending ? "Ending the debate…" : waiting ? "Your opponent is preparing a response. This can take up to two minutes." :
      uncertain ? "Refresh the debate to reconnect and confirm the latest turn." : ended ? "Debate ended. Your transcript is available below until you start a new debate." : pending ? "Generation failed. Retry to continue with the same input." : "";
    $("sync-debate").hidden = !uncertain || waiting;
    $("retry-debate").hidden = !pending || ended || waiting || uncertain;
    $("end-debate").hidden = !session || ended;
    $("end-debate").disabled = ending;
    $("new-debate").hidden = !ended;
    $("argument-form").hidden = !positions || !session?.humanSide || ended;
    $("debate-argument").disabled = waiting || pending || uncertain;
    $("send-argument").disabled = waiting || pending || uncertain;
    $("send-argument").textContent = waiting ? "Waiting for your opponent…" : "Send argument →";
    $("side-picker").hidden = !positions || Boolean(session?.humanSide) || ended;
    for (const button of document.querySelectorAll("[data-side], #regenerate-debate")) button.disabled = waiting || pending || uncertain;
    $("debate-assignments").hidden = !session?.humanSide;
    if (!positions) return;
    $("debate-opponent").textContent = `SIMULATED OPPONENT · ${session.speaker.name}`;
    $("debate-motion").textContent = positions.motion;
    $("debate-model-label").hidden = !session.model;
    $("debate-model-label").textContent = session.model ? `Model: ${session.model.name}` : "";
    $("affirmative-position").textContent = positions.affirmative;
    $("negative-position").textContent = positions.negative;
    $("debate-source-note").textContent = `Source: ${session.speaker.title}. ${session.speaker.remarks.length} of ${session.speaker.totalRemarks} saved remarks supplied to your opponent.${session.speaker.excerpted ? " This source is excerpted." : ""} Source references appear as [cue N].`;
    if (session.humanSide) $("debate-assignments").textContent = `You: ${session.humanSide} · ${positions[session.humanSide]}\n${session.speaker.name} (simulation): ${session.assistantSide} · ${positions[session.assistantSide]}`;
    const key = `${session.id}:${session.messages.length}`;
    if (messageKey !== key) {
      messageKey = key;
      $("debate-messages").replaceChildren();
      for (const [index, message] of session.messages.entries()) {
        const row = node("article", undefined, `debate-message ${message.role}`);
        row.append(node("h3", message.role === "human" ? "YOU" : `${session.speaker.name.toUpperCase()} · SIMULATION`), node("p", message.text));
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
      session = result; uncertain = false; remember(); renderState();
      if (!session.status.startsWith("generating_")) return;
      await new Promise(resolve => setTimeout(resolve, 1500));
    } while (version === operation);
  }
  async function act(action, body = {}) {
    if (!session || (busy && action !== "end")) return;
    const version = ++operation;
    busy = true; ending = action === "end"; error(); renderState();
    try {
      const result = await request(`/api/debates/${session.id}/${action}`, body);
      if (version !== operation) return;
      session = result; uncertain = false; remember();
      if (action === "respond" || (action === "retry" && result.status === "active")) $("debate-argument").value = "";
    } catch (failure) {
      if (version !== operation) return;
      if (failure.session) { session = failure.session; uncertain = false; remember(); }
      else {
        // Reconcile after an interrupted connection before allowing another turn.
        try { await reconcile(session.id, version); }
        catch { if (version === operation) uncertain = true; }
      }
      if (version === operation) error(uncertain ? `${failure.message} Refresh the debate to confirm its state before continuing.` : failure.message);
    } finally {
      if (version === operation) {
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
    busy = true; error(); renderState();
    try {
      session = await request("/api/debates", { speakerId, model: $("debate-model").value }); remember();
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
  $("regenerate-debate").addEventListener("click", () => { void act("prepare", { topic: session.topic }); });
  $("retry-debate").addEventListener("click", () => { void act("retry"); });
  $("end-debate").addEventListener("click", () => { void act("end"); });
  $("new-debate").addEventListener("click", () => { ++operation; session = null; uncertain = false; messageKey = ""; remember(); error(); renderModels(); $("debate-topic").focus(); });
  $("refresh-models").addEventListener("click", () => { void loadModels(); });
  $("debate-model").addEventListener("change", () => {
    modelChoice = $("debate-model").value;
    try { sessionStorage.setItem("debate-model", modelChoice); } catch { /* Storage is optional. */ }
    renderState();
  });
  $("sync-debate").addEventListener("click", async () => {
    if (!session || busy) return;
    const version = ++operation;
    busy = true; error(); renderState();
    try { await reconcile(session.id, version); }
    catch (failure) { error(failure.message); }
    finally { if (version === operation) { busy = false; renderState(); } }
  });
  $("refresh-speakers").addEventListener("click", () => { void loadSpeakers(); });
  $("add-speaker").addEventListener("click", () => { screen("library"); $("speakerName").focus(); });
  $("review-debate-source").addEventListener("click", () => {
    screen("library");
    document.dispatchEvent(new CustomEvent("review-speaker-source", { detail: session?.speaker?.recordId || speakerId }));
  });
  document.addEventListener("speakers-updated", event => updateSpeakers(event.detail));
  document.addEventListener("choose-debate-speaker", event => {
    screen("debate");
    if (session && session.status !== "ended") {
      error("End the current debate and start a new one to change speakers."); return;
    }
    ++operation; session = null; uncertain = false; speakerId = event.detail; remember(); error(); renderSpeakers(); renderModels(); $("debate-topic").focus();
  });
  async function initialize() {
    let id;
    try { id = sessionStorage.getItem("debate-session"); modelChoice = sessionStorage.getItem("debate-model") || ""; } catch { /* Storage is optional. */ }
    if (id) {
      busy = true; renderState();
      try {
        session = await request(`/api/debates/${encodeURIComponent(id)}`);
        speakerId = session.speaker?.recordId || "";
        $("debate-topic").value = session.topic || session.pending?.topic || "";
      } catch { session = null; remember(); error("Your previous debate is no longer available. Start a new one."); }
      finally { busy = false; }
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
  void initialize();
})();
