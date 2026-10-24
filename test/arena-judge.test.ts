import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexArenaJudge, parseArenaJudgment } from "../src/arena-judge.js";
import { providerFixture, POSITIONS } from "./fixture.js";

test("judge validates numeric scores and labels every result provisional", () => {
  const result = parseArenaJudgment(JSON.stringify({ scores: { affirmative: 0, negative: 100 }, rationale: "Both claims were considered." }));
  assert.equal(result.provisional, true);
  assert.match(result.criteria, /TODO/);
  for (const value of [null, {}, { scores: { affirmative: -1, negative: 20 }, rationale: "Bad" },
    { scores: { affirmative: "70", negative: 20 }, rationale: "Bad" },
    { scores: { affirmative: 70, negative: 101 }, rationale: "Bad" },
    { scores: { affirmative: 70, negative: 20 }, rationale: " " },
    { scores: { affirmative: 70, negative: 20 }, rationale: "Fine", extra: true }]) {
    assert.throws(() => parseArenaJudgment(JSON.stringify(value)), /judge/);
  }
});

test("judge uses the actual Codex structured path with placeholder criteria and hides model identities", { timeout: 60_000 }, async t => {
  const fixture = await providerFixture(() => JSON.stringify({ scores: { affirmative: 73, negative: 73 }, rationale: "The arguments are equally supported." }));
  t.after(() => fixture.close());
  const judge = await CodexArenaJudge.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "judge-model" });
  try {
    const result = await judge.judge({ topic: "AI", positions: POSITIONS,
      messages: [{ side: "affirmative", text: "AI assists learning." }, { side: "negative", text: "AI can reduce independent reasoning." }],
      models: { affirmative: "secret-model-name" } }, new AbortController().signal);
    assert.equal(result.scores.affirmative, 73);
    assert.equal(result.provisional, true);
    assert.equal(fixture.requests[0]?.body.model, "judge-model");
    const input = JSON.stringify(fixture.requests[0]?.body.input);
    assert.match(input, /provisional placeholder/);
    assert.match(input, /AI assists learning/);
    assert.doesNotMatch(input, /secret-model-name/);
    assert.doesNotMatch(input, /fixture-secret/);
  } finally { await judge.dispose(); }
});
