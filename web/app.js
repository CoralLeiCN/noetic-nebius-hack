const $ = id => document.getElementById(id);
let selected = null;
let currentView = "summary";
let requestController = null;
let selectionVersion = 0;
let renderVersion = 0;
let transcriptionController = null;
let playbackController = null;
let speechAudioUrl = null;

function stopSpeech() {
  playbackController?.abort();
  playbackController = null;
  $("speech-player").pause();
  $("speech-player").removeAttribute("src");
  $("speech-player").hidden = true;
  if (speechAudioUrl) URL.revokeObjectURL(speechAudioUrl);
  speechAudioUrl = null;
  $("stop-speech").hidden = true;
  $("playback-status").textContent = "";
  $("read-selection").disabled = false;
}

let personas = [];
let selectedPersona = null;
let loadingPersona = false;
let buildingPersona = false;
let personaCatalogError = "";

function speakerKey(name) { return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(); }
function personaFileUrl(id) { return `/api/personas/${encodeURIComponent(id)}/files/persona.md`; }
function personaControls() {
  $("build-persona").disabled = !selected || loadingPersona || buildingPersona;
  $("build-persona").textContent = buildingPersona ? "Building speaker persona…" : selectedPersona ? "Update speaker persona" : "Build speaker persona";
  $("debate-this-speaker").disabled = !selectedPersona || loadingPersona;
}
async function refreshPersonas() {
  personas = await api("/api/personas");
  personaCatalogError = "";
  document.dispatchEvent(new CustomEvent("personas-updated", { detail: personas }));
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function showError(id, message) { $(id).textContent = message || ""; $(id).hidden = !message; }
async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The request failed.");
  return data;
}
function time(seconds) { return seconds === null ? "Untimed" : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function fileUrl(name) { return `/api/videos/${encodeURIComponent(selected.id)}/files/${encodeURIComponent(name)}`; }
function timeNode(cue) {
  if (cue.startSeconds === null || !selected.video) return element("span", time(cue.startSeconds), "time-label");
  const button = element("button", time(cue.startSeconds), "time-button");
  button.type = "button";
  button.title = `Seek video to ${time(cue.startSeconds)}`;
  button.addEventListener("click", () => { $("player").currentTime = cue.startSeconds; $("player").scrollIntoView({ block: "nearest", behavior: "smooth" }); });
  return button;
}

async function refresh(preferredId) {
  showError("library-error", "");
  try {
    const records = await api("/api/videos");
    try { await refreshPersonas(); }
    catch (error) { personaCatalogError = `Could not load speaker personas. ${error.message}`; }
    $("record-count").textContent = `${records.length} record${records.length === 1 ? "" : "s"}`;
    $("record-list").replaceChildren();
    for (const record of records) {
      const card = element("button", undefined, "record-card");
      card.type = "button";
      card.dataset.id = record.id;
      card.setAttribute("aria-pressed", String(record.id === selected?.id));
      card.append(element("strong", record.title), element("span", record.speakerName));
      card.addEventListener("click", () => { void select(record.id); });
      $("record-list").append(card);
    }
    $("empty").hidden = Boolean(records.length);
    if (records.length) await select(preferredId || (records.some(record => record.id === selected?.id) ? selected.id : records[0].id));
    else { selected = null; selectedPersona = null; loadingPersona = false; personaControls(); $("record-view").hidden = true; }
  } catch (error) { showError("library-error", error.message); }
}

async function select(id, requestedPersona = null) {
  const version = ++selectionVersion;
  try {
    const record = await api(`/api/videos/${encodeURIComponent(id)}`);
    if (version !== selectionVersion) return;
    stopSpeech();
    selected = record;
    selectedPersona = requestedPersona;
    loadingPersona = !requestedPersona;
    showError("persona-error", personaCatalogError);
    $("persona-status").textContent = buildingPersona ? "Persona analysis is running. You can keep reviewing sources." : "";
    personaControls();
    showError("library-error", "");
    $("empty").hidden = true;
    $("record-view").hidden = false;
    $("record-speaker").textContent = record.speakerName.toUpperCase();
    $("record-title").textContent = record.title;
    for (const card of document.querySelectorAll(".record-card")) card.setAttribute("aria-pressed", String(card.dataset.id === id));
    $("sources").replaceChildren();
    record.sources.forEach((source, index) => {
      const link = element("a", source.kind === "url" ? `Source video ${index + 1} ↗` : "Uploaded video ↗");
      link.href = source.kind === "url" ? source.reference : fileUrl(source.reference);
      link.target = "_blank"; link.rel = "noopener noreferrer";
      $("sources").append(link);
    });
    $("player").pause();
    $("player").hidden = !record.video;
    if (record.video) $("player").src = fileUrl(record.video.file);
    else $("player").removeAttribute("src");
    $("limitation-list").replaceChildren();
    for (const note of ["Derived from supplied captions; not independently verified against audio.", ...record.analysis.limitations]) $("limitation-list").append(element("li", note));
    await render();
    if (!requestedPersona) {
      try {
        const available = personas.find(persona => speakerKey(persona.speakerName) === speakerKey(record.speakerName));
        const persona = available ? await api(`/api/personas/${encodeURIComponent(available.id)}`) : null;
        if (version !== selectionVersion) return;
        selectedPersona = persona;
      } catch (error) {
        if (version === selectionVersion) showError("persona-error", `Could not load this speaker’s persona. ${error.message}`);
      } finally {
        if (version === selectionVersion) { loadingPersona = false; personaControls(); await render(); }
      }
    }
  } catch (error) { if (version === selectionVersion) showError("library-error", error.message); }
}

async function render() {
  if (!selected) return;
  stopSpeech();
  const version = ++renderVersion;
  const record = selected;
  const content = $("record-content");
  content.replaceChildren();
  for (const button of document.querySelectorAll("[data-view]")) button.setAttribute("aria-pressed", String(button.dataset.view === currentView));
  const files = { summary: "summary.md", remarks: "speaker-remarks.md", transcript: "transcript.txt", record: "record.json" };
  $("download").hidden = currentView === "persona" && !selectedPersona;
  if (currentView === "persona") {
    if (selectedPersona) {
      $("download").href = personaFileUrl(selectedPersona.id);
      content.append(element("p", `Built from ${selectedPersona.sourceCount} saved source${selectedPersona.sourceCount === 1 ? "" : "s"} · ${new Date(selectedPersona.createdAt).toLocaleString()}`, "hint"), element("pre", selectedPersona.markdown));
    } else content.append(element("p", loadingPersona ? "Loading speaker persona…" : "This speaker has no saved persona yet. Build a persona to use their vocabulary, speaking style and debate habits in practice."));
  } else if (currentView === "summary") {
    for (const section of record.analysis.summary) {
      const block = element("section", undefined, "summary-section");
      block.append(element("h3", section.title), element("p", section.text));
      const evidence = element("div", undefined, "evidence");
      for (const index of section.remarkIndexes) {
        const remark = record.analysis.remarks[index];
        const cue = record.transcript.cues[remark.cueId - 1];
        const button = element("button", `Remark ${index + 1} · ${time(cue.startSeconds)}`, "time-button");
        button.type = "button";
        button.addEventListener("click", async () => {
          currentView = "remarks";
          await render();
          document.getElementById(`remark-${index}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
        evidence.append(button);
      }
      block.append(evidence); content.append(block);
    }
  } else if (currentView === "remarks") {
    record.analysis.remarks.forEach((remark, index) => {
      const row = element("div", undefined, "remark"); row.id = `remark-${index}`;
      const marker = element("div");
      marker.append(timeNode(record.transcript.cues[remark.cueId - 1]), element("span", `REMARK ${index + 1}`, "remark-number"));
      const words = element("div"); words.append(element("p", remark.quote));
      if (remark.note) words.append(element("p", `${remark.uncertain ? "Uncertain: " : "Note: "}${remark.note}`, "uncertain"));
      row.append(marker, words); content.append(row);
    });
  } else if (currentView === "record") content.append(element("pre", JSON.stringify(record, null, 2)));
  else {
    content.append(element("p", "Loading transcript…"));
    try {
      const response = await fetch(fileUrl("transcript.txt"));
      if (!response.ok) throw new Error("Could not load the saved transcript.");
      const text = await response.text();
      if (version === renderVersion) content.replaceChildren(element("pre", text));
    } catch (error) { if (version === renderVersion) content.replaceChildren(element("p", error.message, "error")); }
  }
  if (currentView !== "persona") $("download").href = fileUrl(files[currentView]);
}

for (const button of document.querySelectorAll("[data-input]")) button.addEventListener("click", () => {
  const { input, mode } = button.dataset;
  if (input === "transcript") transcriptionController?.abort();
  for (const option of document.querySelectorAll(`[data-input="${input}"]`)) option.setAttribute("aria-pressed", String(option.dataset.mode === mode));
  for (const panel of document.querySelectorAll(`[data-panel="${input}"]`)) {
    const active = panel.dataset.mode === mode;
    panel.hidden = !active;
    for (const field of panel.querySelectorAll("input, textarea")) {
      field.disabled = !active;
      field.required = active && field.dataset.required === "true";
    }
  }
  showError("upload-error", "");
});
for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", () => { currentView = button.dataset.view; void render(); });
$("refresh").addEventListener("click", () => { void refresh(); });
$("debate-this-speaker").addEventListener("click", () => {
  if (selectedPersona) document.dispatchEvent(new CustomEvent("choose-debate-speaker", { detail: selectedPersona.id }));
});
document.addEventListener("review-speaker-persona", async event => {
  try {
    const persona = await api(`/api/personas/${encodeURIComponent(event.detail)}`);
    if (!persona.sourceIds.length) throw new Error("This persona has no source record to review.");
    currentView = "persona";
    await select(persona.sourceIds[0], persona);
  } catch (error) { showError("library-error", error.message); }
});
$("build-persona").addEventListener("click", async () => {
  if (!selected || loadingPersona || buildingPersona) return;
  const speakerName = selected.speakerName;
  buildingPersona = true;
  showError("persona-error", "");
  $("persona-status").textContent = `Analyzing all saved sources for ${speakerName} and writing their persona…`;
  personaControls();
  try {
    const persona = await api("/api/personas", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ speakerName }),
    });
    personas = [{ id: persona.id, speakerName: persona.speakerName, createdAt: persona.createdAt, sourceCount: persona.sourceCount },
      ...personas.filter(saved => speakerKey(saved.speakerName) !== speakerKey(persona.speakerName))];
    document.dispatchEvent(new CustomEvent("personas-updated", { detail: personas }));
    if (selected && speakerKey(selected.speakerName) === speakerKey(speakerName)) {
      selectedPersona = persona;
      currentView = "persona";
      $("persona-status").textContent = "Persona saved. Review the Markdown below, then start practice.";
      await render();
    } else $("persona-status").textContent = `Persona saved for ${speakerName}. Select one of their sources to review it.`;
    try { await refreshPersonas(); }
    catch (error) { showError("persona-error", `Persona saved, but the speaker list could not be refreshed. ${error.message}`); }
  } catch (error) {
    $("persona-status").textContent = "Persona generation failed. You can retry with the build button.";
    showError("persona-error", error.message);
  } finally { buildingPersona = false; personaControls(); }
});
$("cancel").addEventListener("click", () => requestController?.abort());
$("upload-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (requestController) return;
  if (transcriptionController) return showError("upload-error", "Finish or cancel transcription before generating a record.");
  showError("upload-error", "");
  const form = new FormData(event.currentTarget);
  const video = form.get("video");
  const transcript = form.get("transcript");
  const pastedTranscript = form.get("transcriptText") || "";
  const hasVideo = video instanceof File && video.size > 0;
  const hasTranscriptFile = transcript instanceof File && transcript.size > 0;
  if (!(form.get("sourceUrls") || "").trim() && !hasVideo) return showError("upload-error", "Paste a video link or upload a video file.");
  if (!hasTranscriptFile && !pastedTranscript.trim()) return showError("upload-error", "Paste the transcript or upload a transcript file.");
  if ((hasVideo && video.size > 100 * 1024 * 1024) || (hasTranscriptFile && transcript.size > 1024 * 1024) || new TextEncoder().encode(pastedTranscript).length > 1024 * 1024 || pastedTranscript.length > 500000) {
    return showError("upload-error", "Video limit: 100 MiB. Transcript limit: 1 MiB and 500,000 characters.");
  }
  requestController = new AbortController();
  $("upload-fields").disabled = true;
  $("submit").textContent = "Generating record…";
  $("cancel").hidden = false;
  $("upload-status").textContent = "Extracting and checking the speaker’s remarks. This can take up to two minutes after upload.";
  try {
    const record = await api("/api/videos", { method: "POST", body: form, signal: requestController.signal });
    $("upload-status").textContent = "Record saved. Review the remarks and source notes below.";
    await refresh(record.id);
  } catch (error) {
    $("upload-status").textContent = error.name === "AbortError" ? "Generation canceled. Refresh the library to check whether a record finished saving." : "";
    if (error.name !== "AbortError") showError("upload-error", error.message);
  } finally {
    requestController = null;
    $("upload-fields").disabled = false;
    $("submit").textContent = "Generate record ↗";
    $("cancel").hidden = true;
  }
});

$("cancel-transcription").addEventListener("click", () => transcriptionController?.abort());
$("transcribe-audio").addEventListener("click", async () => {
  if (transcriptionController) return;
  showError("speech-error", "");
  const file = $("speech-file").files[0];
  if (!file || !file.size || file.size > 16 * 1024 * 1024) return showError("speech-error", "Choose an audio file of at most 16 MiB and 120 seconds.");
  const original = $("transcriptText").value;
  const controller = new AbortController();
  transcriptionController = controller;
  $("transcribe-audio").disabled = true;
  $("cancel-transcription").hidden = false;
  $("speech-status").textContent = "Transcribing audio locally…";
  try {
    const result = await api("/api/speech/transcriptions", { method: "POST", body: file, signal: controller.signal });
    controller.signal.throwIfAborted();
    if ($("transcriptText").value !== original) throw new Error("The transcript was edited while transcription ran. Your edits were kept; retry when ready.");
    $("transcriptText").value = result.text;
    $("speech-status").textContent = result.text.trim() ? "Transcript ready. Review recognition errors and speaker attribution before generating a record." : "No speech was recognized.";
  } catch (error) {
    $("speech-status").textContent = controller.signal.aborted ? "Transcription canceled." : "";
    if (!controller.signal.aborted) showError("speech-error", error.message);
  } finally {
    transcriptionController = null;
    $("transcribe-audio").disabled = false;
    $("cancel-transcription").hidden = true;
  }
});

$("stop-speech").addEventListener("click", stopSpeech);
$("read-selection").addEventListener("click", async () => {
  showError("playback-error", "");
  const selection = window.getSelection();
  const text = selection?.toString().trim() || "";
  if (!text || text.length > 600 || !selection.rangeCount || !$("record-content").contains(selection.getRangeAt(0).commonAncestorContainer)) {
    return showError("playback-error", "Select up to 600 characters in the record above to read aloud.");
  }
  stopSpeech();
  const controller = new AbortController();
  playbackController = controller;
  $("read-selection").disabled = true;
  $("stop-speech").hidden = false;
  $("playback-status").textContent = "Generating speech locally…";
  try {
    const response = await fetch("/api/speech/audio", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: text }), signal: controller.signal });
    if (!response.ok) throw new Error((await response.json()).error || "Speech generation failed.");
    const audio = await response.blob();
    controller.signal.throwIfAborted();
    speechAudioUrl = URL.createObjectURL(audio);
    $("speech-player").src = speechAudioUrl;
    $("speech-player").hidden = false;
    $("playback-status").textContent = "Speech ready.";
    try { await $("speech-player").play(); } catch { if (!controller.signal.aborted) $("playback-status").textContent = "Speech ready. Press Play to listen."; }
  } catch (error) {
    if (!controller.signal.aborted) { stopSpeech(); showError("playback-error", error.message); }
  } finally {
    if (playbackController === controller) $("read-selection").disabled = false;
  }
});
window.addEventListener("pagehide", () => { transcriptionController?.abort(); stopSpeech(); });
document.addEventListener("workspace-screen-changed", event => {
  if (event.detail !== "library") { transcriptionController?.abort(); stopSpeech(); }
});
void refresh();
