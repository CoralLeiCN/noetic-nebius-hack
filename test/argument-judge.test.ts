import { test } from "node:test";
import assert from "node:assert/strict";
import { ARGUMENT_CRITERIA, CodexArgumentJudge, parseArgumentJudgment } from "../src/argument-judge.js";
import { POSITIONS, providerFixture } from "./fixture.js";

function feedback(score = 74) {
  return {
    rationale: "Clear claims; develop the causal link.",
    breakdown: {
      clarity: { score, comment: "The main claim is easy to identify." },
      reasoning: { score, comment: "Explain how the proposed change creates the benefit." },
      engagement: { score, comment: "Address the concern about independent reasoning." },
    },
  };
}

test("speech judge validates all criterion results and calculates the rounded mean", () => {
  for (const score of [0, 72.5, 100]) {
    const value = feedback(score);
    assert.deepEqual(parseArgumentJudgment(JSON.stringify(value)), {
      ...value, score: Math.round(score), criteria: ARGUMENT_CRITERIA, provisional: true,
    });
  }
  const value = feedback();
  value.rationale = "  Clear claims; develop the causal link.  ";
  value.breakdown.clarity = { score: 90, comment: "  The claim is easy to identify.  " };
  value.breakdown.reasoning.score = 61;
  value.breakdown.engagement.score = 80;
  const result = parseArgumentJudgment(JSON.stringify(value));
  assert.equal(result.score, 77);
  assert.equal(result.rationale, value.rationale.trim());
  assert.equal(result.breakdown.clarity.comment, "The claim is easy to identify.");
});

test("speech judge rejects missing, malformed and verbose results instead of inventing a breakdown", () => {
  const valid = feedback();
  for (const value of [null, [], {}, { score: 74, rationale: "Old output without a breakdown." },
    { ...valid, score: 74 }, { ...valid, extra: true },
    { ...valid, rationale: " " }, { ...valid, rationale: "x".repeat(181) },
    { ...valid, rationale: 1 }, { ...valid, breakdown: null }, { ...valid, breakdown: [] },
    { ...valid, breakdown: { ...valid.breakdown, clarity: undefined } },
    { ...valid, breakdown: { ...valid.breakdown, extra: valid.breakdown.clarity } },
  ]) {
    assert.throws(() => parseArgumentJudgment(JSON.stringify(value)), /judge/);
  }
  for (const criterion of [null, [], {},
    { score: -1, comment: "Bad" }, { score: 101, comment: "Bad" },
    { score: "70", comment: "Bad" }, { score: null, comment: "Bad" },
    { score: 70, comment: " " }, { score: 70, comment: "x".repeat(241) },
    { score: 70, comment: 1 }, { score: 70, comment: "Fine", extra: true },
  ]) {
    for (const name of ["clarity", "reasoning", "engagement"]) {
      const value = { ...valid, breakdown: { ...valid.breakdown, [name]: criterion } };
      assert.throws(() => parseArgumentJudgment(JSON.stringify(value)), /judge/);
    }
  }
  const atLimit = feedback();
  atLimit.rationale = "x".repeat(180);
  atLimit.breakdown.clarity.comment = "x".repeat(240);
  assert.equal(parseArgumentJudgment(JSON.stringify(atLimit)).score, 74);
  assert.throws(() => parseArgumentJudgment("not JSON"), /judge/);
  assert.throws(() => parseArgumentJudgment(JSON.stringify(valid).replace('"score":74', '"score":1e999')), /judge/);
});

test("speech judge uses structured SDK output, neutral text criteria and anonymous debate content", { timeout: 60_000 }, async t => {
  const fixture = await providerFixture(() => JSON.stringify(feedback()));
  t.after(() => fixture.close());
  const judge = await CodexArgumentJudge.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "judge-model" });
  try {
    const input = {
      topic: "AI", positions: POSITIONS, side: "affirmative" as const, text: "Um, AI assists learning.",
      messages: [{ side: "negative" as const, text: "AI can reduce independent reasoning.", role: "human", judgment: { score: 99 } }],
      model: "secret-model-name", speaker: "private-persona", role: "assistant",
    };
    const result = await judge.judge(input, new AbortController().signal);
    assert.equal(result.score, 74);
    assert.deepEqual(result.breakdown, feedback().breakdown);
    assert.equal(result.criteria, ARGUMENT_CRITERIA);
    assert.equal(fixture.requests[0]?.body.model, "judge-model");
    const prompt = JSON.stringify(fixture.requests[0]?.body.input);
    assert.match(prompt, /Um, AI assists learning/);
    assert.match(prompt, /AI can reduce independent reasoning/);
    assert.match(prompt, /Do not penalize filler words/);
    assert.match(prompt, /not a verdict on the whole debate/);
    assert.match(prompt, /at most 20 words and 180 characters/);
    assert.match(prompt, /equally weighted mean/);
    assert.match(prompt, /exactly clarity, reasoning and engagement/);
    assert.doesNotMatch(prompt, /secret-model-name|private-persona|fixture-secret/);
    const debate = JSON.parse((fixture.requests[0]!.body.input as { content: { text: string }[] }[])
      .flatMap(item => item.content ?? []).map(item => item.text ?? "").join("\n").split("Debate data: ").at(-1)!);
    assert.deepEqual(debate.precedingSpeeches, [{ side: "negative", text: "AI can reduce independent reasoning." }]);
    assert.deepEqual(debate.speech, { side: "affirmative", text: "Um, AI assists learning." });
  } finally { await judge.dispose(); }
});
