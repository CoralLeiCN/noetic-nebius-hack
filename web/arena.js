(() => {
  const $ = id => document.getElementById(id);
  const sides = ["affirmative", "negative"];
  const roles = [...sides, "judge"];
  let speakers = [];
  let speakerId = "";
  let models = [];
  let defaultModel = "";
  let session = null;
  let busy = false;
  let ending = false;
  let activeAction = "";
  let uncertain = false;
  let operation = 0;
  let loadingModels = false;
  let initialized = false;
  let messageKey = "";
  let modelChoices = {};

  function node(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  }
  function error(message = "") { $("arena-error").textContent = message; $("arena-error").hidden = !message; }
  function remember() {
    try {
      if (session) sessionStorage.setItem("arena-session", session.id);
      else sessionStorage.removeItem("arena-session");
      sessionStorage.setItem("arena-models", JSON.stringify(modelChoices));
    } catch { /* Arena also works without browser storage. */ }
  }
  async function request(path, body) {
    const response = await fetch(path, body === undefined ? undefined : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) {
      const failure = new Error(result.error || "The Arena request failed.");
      failure.session = result.session;
      throw failure;
    }
    return result;
  }
  function label(model) { return model ? `${model.providerName} · ${model.name}` : ""; }
  function generating() { return session?.status.startsWith("generating_") || session?.status === "judging"; }
  function renderSpeakers() {
    $("arena-speaker-options").replaceChildren();
    for (const speaker of speakers) {
      const card = node("label", undefined, "speaker-card");
      const radio = node("input");
      radio.type = "radio"; radio.name = "arena-speaker"; radio.value = speaker.id;
      radio.checked = speaker.id === speakerId; radio.required = true;
      radio.addEventListener("change", () => { speakerId = speaker.id; render(); });
      const copy = node("span"); copy.append(node("strong", speaker.speakerName), node("small", speaker.title));
      card.append(radio, copy); $("arena-speaker-options").append(card);
    }
    $("arena-speaker-empty").hidden = Boolean(speakers.length);
    render();
  }
  function updateSpeakers(records) {
    speakers = records;
    if (!speakers.some(speaker => speaker.id === speakerId)) speakerId = session?.speaker?.recordId || speakers[0]?.id || "";
    renderSpeakers();
  }
  async function loadSpeakers() {
    $("arena-refresh-speakers").disabled = true;
    try { updateSpeakers(await request("/api/videos")); }
    catch (failure) { error(`Could not load ready speakers. ${failure.message}`); }
    finally { $("arena-refresh-speakers").disabled = false; }
  }
  function renderModels() {
    for (const [index, role] of roles.entries()) {
      const select = $(`arena-${role}-model`);
      const options = [...models];
      const saved = session?.models[role];
      if (saved && !options.some(model => model.key === saved.key)) options.push(saved);
      const desired = saved?.key || modelChoices[role] || (index === 1 ? models.find(model => model.key !== modelChoices.affirmative)?.key : defaultModel);
      select.replaceChildren();
      for (const provider of [...new Set(options.map(model => model.providerName))]) {
        const group = node("optgroup"); group.label = provider;
        for (const model of options.filter(model => model.providerName === provider)) {
          const option = node("option", model.name); option.value = model.key; group.append(option);
        }
        select.append(group);
      }
      if (!options.length) {
        const placeholder = node("option", loadingModels ? "Loading models…" : "No models available");
        placeholder.value = ""; select.append(placeholder);
      }
      select.value = options.some(model => model.key === desired) ? desired : options[0]?.key || "";
      if (!session) modelChoices[role] = select.value;
    }
    render();
  }
  async function loadModels() {
    if (loadingModels) return;
    loadingModels = true; $("arena-model-error").hidden = true; render();
    try {
      const catalog = await request("/api/arena/models");
      models = catalog.models; defaultModel = catalog.defaultModel || "";
      if (!models.length) throw new Error("No models are available from the configured providers.");
      if (catalog.warnings?.length) {
        $("arena-model-error").textContent = catalog.warnings.join(" ");
        $("arena-model-error").hidden = false;
      }
    } catch (failure) {
      models = [];
      $("arena-model-error").textContent = `Could not load models. ${failure.message}`;
      $("arena-model-error").hidden = false;
    } finally { loadingModels = false; renderModels(); }
  }
  function renderScores() {
    const judgment = session?.judgment;
    $("arena-scores").hidden = !judgment;
    $("arena-scores").replaceChildren();
    $("arena-judgment").textContent = judgment ? judgment.rationale : session.messages.length === 4 ? "No scores yet. Ask the judge to evaluate the completed arguments." : "The models are debating. Scores will appear after the judge evaluates the completed arguments.";
    if (!judgment) return;
    for (const side of sides) {
      const score = judgment.scores[side];
      const row = node("div", undefined, `arena-score ${side}`);
      const heading = node("div", undefined, "arena-score-heading");
      heading.append(node("span", `${side.toUpperCase()} · ${label(session.models[side])}`), node("strong", `${score} / 100`));
      const track = node("div", undefined, "arena-score-track");
      track.setAttribute("role", "meter"); track.setAttribute("aria-label", `${side} score`);
      track.setAttribute("aria-valuemin", "0"); track.setAttribute("aria-valuemax", "100"); track.setAttribute("aria-valuenow", String(score));
      const fill = node("div", undefined, "arena-score-fill"); fill.style.width = `${Math.max(0, Math.min(100, score))}%`;
      track.append(fill); row.append(heading, track); $("arena-scores").append(row);
    }
    const rubric = node("p", `Placeholder criteria: ${judgment.criteria}`, "hint");
    $("arena-scores").append(rubric);
  }
  function render() {
    const ended = session?.status === "ended";
    const completed = session?.status === "completed";
    const waiting = busy || (generating() && !uncertain);
    const positions = session?.positions;
    const pending = Boolean(session?.pending);
    const judging = session?.status === "judging" || (busy && activeAction === "judge");
    const running = session?.status === "generating_arguments" || (busy && activeAction === "run");
    $("arena-fields").disabled = waiting || Boolean(session);
    $("arena-prepare").disabled = waiting || loadingModels || !speakers.length || roles.some(role => !$(`arena-${role}-model`).value);
    $("arena-prepare").textContent = waiting && !positions ? "Preparing comparison…" : "Prepare comparison ↗";
    for (const role of roles) $(`arena-${role}-model`).disabled = loadingModels || !models.length;
    $("arena-refresh-models").disabled = loadingModels;
    $("arena-review-source").hidden = !(session?.speaker?.recordId || speakerId);
    $("arena-welcome").hidden = Boolean(positions);
    $("arena-detail").hidden = !positions;
    $("arena-badge").textContent = ended ? "ENDED" : uncertain ? "RECONNECT" : judging ? "JUDGING" : waiting ? "GENERATING" : completed ? "SCORED" : session?.status === "awaiting_judgment" ? "READY TO JUDGE" : positions ? "POSITIONS READY" : "SETUP";
    $("arena-status").textContent = ending ? "Ending the comparison…" : uncertain ? "Refresh the comparison to confirm its latest state." :
      waiting ? judging ? "The judge is evaluating the arguments with a provisional rubric." : running ? "The models are taking turns. Completed arguments appear below." : "Preparing the opposing positions. This can take up to two minutes." :
      ended ? "Comparison ended. The completed transcript and any scores remain below." : pending ? "Generation stopped. Retry to continue from the last completed step." : "";
    $("arena-sync").hidden = !uncertain || waiting;
    $("arena-retry").hidden = !pending || waiting || ended || uncertain;
    $("arena-end").hidden = !session || ended || completed;
    $("arena-end").disabled = ending;
    $("arena-new").hidden = !ended && !completed;
    $("arena-new").disabled = waiting;
    $("arena-run-controls").hidden = session?.status !== "positions_ready" || pending || uncertain;
    $("arena-run").disabled = waiting;
    $("arena-regenerate").disabled = waiting;
    $("arena-evaluation").hidden = !positions || (!session.messages.length && !completed);
    $("arena-judge").hidden = session?.status !== "awaiting_judgment" || pending || uncertain;
    $("arena-judge").disabled = waiting;
    if (!positions) return;
    $("arena-speaker-note").textContent = `${session.speaker.name.toUpperCase()} · SOURCE-INFORMED SIMULATIONS`;
    $("arena-motion").textContent = positions.motion;
    $("arena-source-note").textContent = `Source: ${session.speaker.title}. Both models receive the same ${session.speaker.remarks.length} of ${session.speaker.totalRemarks} saved remarks.${session.speaker.excerpted ? " This source is excerpted." : ""} Source references appear as [cue N].`;
    for (const side of sides) {
      $(`arena-${side}-label`).textContent = `${side.toUpperCase()} · ${label(session.models[side])}`;
      $(`arena-${side}-position`).textContent = positions[side];
    }
    $("arena-judge-label").textContent = `Judge: ${label(session.models.judge)}`;
    const key = `${session.id}:${session.messages.length}`;
    if (messageKey !== key) {
      messageKey = key; $("arena-messages").replaceChildren();
      for (const [index, message] of session.messages.entries()) {
        const row = node("article", undefined, `debate-message ${message.side}`);
        row.setAttribute("aria-label", `Turn ${index + 1}`);
        row.append(node("h3", `${message.side.toUpperCase()} · ${label(session.models[message.side])} · SIMULATION`), node("p", message.text));
        $("arena-messages").append(row);
      }
      $("arena-messages").scrollTop = $("arena-messages").scrollHeight;
    }
    renderScores();
  }
  async function reconcile(id, version, untilSettled = true) {
    do {
      const result = await request(`/api/arenas/${encodeURIComponent(id)}`);
      if (version !== operation) return;
      session = result; uncertain = false; remember(); render();
      if (!untilSettled || !generating()) return;
      await new Promise(resolve => setTimeout(resolve, 1500));
    } while (version === operation);
  }
  async function monitor(id, version) {
    while (busy && version === operation) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (!busy || version !== operation) return;
      try {
        const result = await request(`/api/arenas/${encodeURIComponent(id)}`);
        if (!busy || version !== operation) return;
        session = result; uncertain = false; remember(); render();
      } catch { /* The action reconciles errors when its request finishes. */ }
    }
  }
  async function act(action, body = {}) {
    if (!session || (busy && action !== "end")) return;
    const version = ++operation;
    busy = true; ending = action === "end"; activeAction = action === "retry" ? session.pending?.kind || "" : action; error(); render();
    const pendingRequest = request(`/api/arenas/${session.id}/${action}`, body);
    void monitor(session.id, version);
    try {
      const result = await pendingRequest;
      if (version !== operation) return;
      session = result; uncertain = false; remember();
    } catch (failure) {
      if (version !== operation) return;
      if (failure.session) { session = failure.session; uncertain = false; remember(); }
      else {
        try { await reconcile(session.id, version); }
        catch { if (version === operation) uncertain = true; }
      }
      if (version === operation) error(uncertain ? `${failure.message} Refresh the comparison before continuing.` : failure.message);
    } finally { if (version === operation) { busy = false; ending = false; activeAction = ""; render(); } }
  }
  $("arena-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !speakerId || loadingModels) return;
    const topic = $("arena-topic").value.trim();
    if (!topic || roles.some(role => !$(`arena-${role}-model`).value)) return;
    busy = true; error(); render();
    try {
      session = await request("/api/arenas", { speakerId, affirmativeModel: $("arena-affirmative-model").value, negativeModel: $("arena-negative-model").value, judgeModel: $("arena-judge-model").value });
      remember();
    } catch (failure) { error(failure.message); }
    finally { busy = false; render(); }
    if (session?.status === "topic_entry") await act("prepare", { topic });
  });
  $("arena-run").addEventListener("click", () => { void act("run"); });
  $("arena-judge").addEventListener("click", () => { void act("judge"); });
  $("arena-regenerate").addEventListener("click", () => { void act("prepare", { topic: session.topic }); });
  $("arena-retry").addEventListener("click", () => { void act("retry"); });
  $("arena-end").addEventListener("click", () => { void act("end"); });
  $("arena-new").addEventListener("click", () => { ++operation; session = null; uncertain = false; messageKey = ""; remember(); error(); renderModels(); $("arena-topic").focus(); });
  $("arena-refresh-models").addEventListener("click", () => { void loadModels(); });
  $("arena-refresh-speakers").addEventListener("click", () => { void loadSpeakers(); });
  for (const role of roles) $(`arena-${role}-model`).addEventListener("change", () => { modelChoices[role] = $(`arena-${role}-model`).value; remember(); render(); });
  $("arena-sync").addEventListener("click", async () => {
    if (!session || busy) return;
    const version = ++operation; busy = true; error(); render();
    try { await reconcile(session.id, version); }
    catch (failure) { if (version === operation) error(failure.message); }
    finally { if (version === operation) { busy = false; render(); } }
  });
  $("arena-review-source").addEventListener("click", () => {
    document.querySelector('[data-screen="library"]').click();
    document.dispatchEvent(new CustomEvent("review-speaker-source", { detail: session?.speaker?.recordId || speakerId }));
  });
  document.addEventListener("speakers-updated", event => updateSpeakers(event.detail));
  document.addEventListener("workspace-screen", event => { if (event.detail === "arena" && !initialized) { initialized = true; void initialize(); } });
  async function initialize() {
    let id;
    try {
      id = sessionStorage.getItem("arena-session");
      modelChoices = JSON.parse(sessionStorage.getItem("arena-models") || "{}");
      if (!modelChoices || typeof modelChoices !== "object") modelChoices = {};
    } catch { modelChoices = {}; }
    if (id) {
      busy = true; render();
      try {
        session = await request(`/api/arenas/${encodeURIComponent(id)}`);
        speakerId = session.speaker.recordId;
        $("arena-topic").value = session.topic || session.pending?.topic || "";
      } catch { session = null; remember(); error("Your previous comparison is no longer available. Start a new one."); }
      finally { busy = false; }
    }
    await Promise.all([loadSpeakers(), loadModels()]);
    if (generating()) {
      const version = operation;
      try { await reconcile(session.id, version); }
      catch (failure) { if (version === operation) { uncertain = true; error(failure.message); } }
    }
    render();
  }
})();
