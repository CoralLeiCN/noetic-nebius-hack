import { test } from "node:test";
import assert from "node:assert/strict";
import { UiElement, eventTarget, htmlElements, runUiScript, flush, textOf } from "./ui-fixture.js";

const socrates = {
  id: "persona-00000000-0000-4000-8000-000000000001", kind: "authored", speakerName: "Socrates",
  createdAt: "2026-10-24T00:00:00.000Z", sourceCount: 0, sourceIds: [], sources: [],
  analysis: { dimensions: [], limitations: ["An authored simulation, not an evidence-based reconstruction."] },
  markdown: "# Socrates\nAsk what a key word means, use an everyday analogy, and finish with a clear claim.",
};
const video = {
  id: "video-example", title: "A recorded debate", speakerName: "Alex", sources: [], video: null,
  analysis: { limitations: [], summary: [{ title: "The case", text: "A concrete policy argument.", remarkIndexes: [] }] },
  transcript: { cues: [] },
};
const settle = () => flush(3);

async function library(withVideo = false) {
  const { html, element } = await htmlElements("all");
  const views = [...html.matchAll(/data-view="([^"]+)"/gu)].map(match => {
    const button = new UiElement("all"); button.dataset.view = match[1]!; return button;
  });
  const buildHint = new UiElement("all");
  const created: UiElement[] = [];
  const documentEvents = eventTarget();
  const emitted: { type: string; detail: unknown }[] = [];
  const requests: string[] = [];
  const fetch = async (path: string): Promise<Response> => {
    requests.push(path);
    if (path === "/api/videos") return Response.json(withVideo ? [video] : []);
    if (path === "/api/personas") return Response.json([socrates]);
    if (path === `/api/personas/${socrates.id}`) return Response.json(socrates);
    if (path === `/api/videos/${video.id}`) return Response.json(video);
    throw new Error(`Unexpected request: ${path}`);
  };
  await runUiScript("web/app.js", {
    document: {
      getElementById: element,
      createElement: () => { const result = new UiElement("all"); created.push(result); return result; },
      querySelectorAll: (selector: string) => selector === "[data-view]" ? views :
        selector === "#record-view > .hint" ? [buildHint] : selector === ".record-card" ? created.filter(item => item.className === "record-card") : [],
      addEventListener: documentEvents.addEventListener,
      dispatchEvent: (event: { type: string; detail: unknown }) => { emitted.push(event); },
    },
    window: { addEventListener() {} },
    CustomEvent: class {
      constructor(readonly type: string, readonly options: { detail: unknown }) {}
      get detail() { return this.options.detail; }
    },
    fetch, URL, console,
  });
  await settle();
  return {
    element, views, requests, buildHint, emitted,
    card(id: string) { const card = element("record-list").children.find(item => item.dataset.id === id); assert.ok(card); return card; },
    async review(id: string) { await documentEvents.emitAsync("review-speaker-persona", id); await settle(); },
  };
}

test("an authored persona appears in an otherwise empty library and can be reviewed, downloaded and selected for practice", async () => {
  const app = await library();
  assert.match(textOf(app.card(socrates.id)), /Socrates Authored persona/);
  assert.equal(app.element("empty").hidden, true);
  assert.equal(app.element("record-view").hidden, false);
  assert.equal(app.element("record-title").textContent, "Socrates persona");
  assert.match(textOf(app.element("record-content")), /Authored persona.*Socrates/s);
  assert.equal(app.element("download").href, `/api/personas/${socrates.id}/files/persona.md`);
  assert.equal(app.element("download").hidden, false);
  assert.equal(app.element("build-persona").hidden, true);
  assert.equal(app.element("build-persona").disabled, true);
  assert.equal(app.buildHint.hidden, true);
  for (const button of app.views.filter(item => item.dataset.view !== "persona")) {
    assert.equal(button.hidden, true);
    assert.equal(button.disabled, true);
  }
  assert.match(textOf(app.element("limitation-list")), /authored simulation/);
  assert.equal(app.requests.some(path => path.startsWith("/api/videos/")), false);
  app.element("debate-this-speaker").emit("click");
  assert.equal(app.emitted.at(-1)?.type, "choose-debate-speaker");
  assert.equal(app.emitted.at(-1)?.detail, socrates.id);
});

test("authored selection survives refresh and returning to a video restores source views and build controls", async () => {
  const app = await library(true);
  assert.match(textOf(app.element("record-content")), /A concrete policy argument/);
  app.card(socrates.id).emit("click");
  await settle();
  app.element("refresh").emit("click");
  await settle();
  assert.equal(app.element("record-title").textContent, "Socrates persona");
  assert.equal(app.card(socrates.id).attributes.get("aria-pressed"), "true");
  app.card(video.id).emit("click");
  await settle();
  assert.equal(app.element("record-title").textContent, video.title);
  assert.match(textOf(app.element("record-content")), /A concrete policy argument/);
  assert.equal(app.element("build-persona").hidden, false);
  assert.equal(app.element("build-persona").disabled, false);
  assert.equal(app.element("sources").hidden, false);
  assert.equal(app.buildHint.hidden, false);
  for (const button of app.views) { assert.equal(button.hidden, false); assert.equal(button.disabled, false); }
  assert.equal(app.element("download").href, `/api/videos/${video.id}/files/summary.md`);
});

test("reviewing an authored persona from practice does not require a video source", async () => {
  const app = await library(true);
  await app.review(socrates.id);
  assert.equal(app.element("record-title").textContent, "Socrates persona");
  assert.equal(app.element("library-error").hidden, true);
  assert.match(textOf(app.element("record-content")), /everyday analogy/);
  assert.equal(app.element("player").hidden, true);
});
