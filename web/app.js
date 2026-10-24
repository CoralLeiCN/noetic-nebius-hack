const $ = id => document.getElementById(id);
let selected = null;
let currentView = "summary";
let requestController = null;
let selectionVersion = 0;
let renderVersion = 0;

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
    document.dispatchEvent(new CustomEvent("speakers-updated", { detail: records }));
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
    if (preferredId || !selected || !records.some(record => record.id === selected.id)) {
      if (records.length) await select(preferredId || records[0].id);
      else { selected = null; $("record-view").hidden = true; }
    }
  } catch (error) { showError("library-error", error.message); }
}

async function select(id) {
  const version = ++selectionVersion;
  try {
    const record = await api(`/api/videos/${encodeURIComponent(id)}`);
    if (version !== selectionVersion) return;
    selected = record;
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
  } catch (error) { if (version === selectionVersion) showError("library-error", error.message); }
}

async function render() {
  if (!selected) return;
  const version = ++renderVersion;
  const record = selected;
  const content = $("record-content");
  content.replaceChildren();
  for (const button of document.querySelectorAll("[data-view]")) button.setAttribute("aria-pressed", String(button.dataset.view === currentView));
  const files = { summary: "summary.md", remarks: "speaker-remarks.md", transcript: "transcript.txt", record: "record.json" };
  $("download").href = fileUrl(files[currentView]);
  if (currentView === "summary") {
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
}

for (const button of document.querySelectorAll("[data-input]")) button.addEventListener("click", () => {
  const { input, mode } = button.dataset;
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
  if (selected) document.dispatchEvent(new CustomEvent("choose-debate-speaker", { detail: selected.id }));
});
document.addEventListener("review-speaker-source", event => { void select(event.detail); });
$("cancel").addEventListener("click", () => requestController?.abort());
$("upload-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (requestController) return;
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
void refresh();
