import { test } from "node:test";
import assert from "node:assert/strict";
import { DebateSession, parsePositions, type DebateAgent, type PracticeContext } from "../src/debate.js";
import { POSITIONS, speechBreakdown } from "./fixture.js";
import type { ArgumentJudge, ArgumentJudgeInput, ArgumentJudgment } from "../src/argument-judge.js";

class FakeAgent implements DebateAgent {
  topics: string[] = [];
  calls: { context: PracticeContext; contribution: string }[] = [];
  fail = false;
  wait: Promise<string> | null = null;
  resetPractice() {}
  async prepare(topic: string) { this.topics.push(topic); return POSITIONS; }
  async opening(_context: PracticeContext) { return "Opening arguments"; }
  async reply(context: PracticeContext, contribution: string) {
    this.calls.push({ context, contribution });
    if (this.fail) throw new Error("simulated transport failure");
    return this.wait ?? "Response to your argument";
  }
}

test("topic, regeneration, either side, and multiple contextual turns", async () => {
  for (const side of ["affirmative", "negative"] as const) {
    const agent = new FakeAgent();
    const session = new DebateSession(agent);
    await assert.rejects(session.prepare("  "), /empty/);
    assert.equal(agent.topics.length, 0);
    await session.prepare("AI in education");
    await session.prepare("Another topic");
    assert.equal(session.snapshot.topic, "Another topic");
    assert.equal(session.snapshot.messages.length, 0);
    await session.choose(side);
    assert.equal(session.snapshot.assistantSide, side === "affirmative" ? "negative" : "affirmative");
    await session.respond("First argument");
    await session.respond("Second argument");
    assert.equal(session.snapshot.messages.length, 5);
    assert.equal(agent.calls[1]?.context.messages.length, 3);
    assert.equal(agent.calls[1]?.context.humanSide, side);
    await assert.rejects(session.choose("negative"), /unavailable/);
    const copy = session.snapshot;
    copy.messages.length = 0;
    assert.equal(session.snapshot.messages.length, 5);
  }
});

test("failed turns retain state and retries do not duplicate human messages", async () => {
  const agent = new FakeAgent();
  const session = new DebateSession(agent);
  await session.prepare("AI");
  await session.choose("negative");
  agent.fail = true;
  await assert.rejects(session.respond("Pending argument"));
  assert.equal(session.snapshot.status, "active");
  assert.equal(session.snapshot.messages.length, 1);
  assert.equal(session.snapshot.pending?.kind, "reply");
  await assert.rejects(session.respond("Different argument"), /pending/);
  agent.fail = false;
  await session.retry();
  assert.deepEqual(session.snapshot.messages.map(m => m.role), ["assistant", "human", "assistant"]);
  assert.equal(session.snapshot.messages[1]?.text, "Pending argument");
});

test("ending during generation rejects concurrent turns and ignores late results", async () => {
  const agent = new FakeAgent();
  let resolve!: (text: string) => void;
  agent.wait = new Promise<string>(done => { resolve = done; });
  const session = new DebateSession(agent);
  await session.prepare("AI");
  await session.choose("affirmative");
  const run = session.respond("An argument");
  await assert.rejects(session.respond("Duplicate"), /unavailable/);
  session.end();
  resolve("Late response");
  await run;
  assert.equal(session.snapshot.status, "ended");
  assert.equal(session.snapshot.messages.length, 1);
  await assert.rejects(session.retry(), /unavailable/);
});

test("sessions keep their own topic, sides, and transcript", async () => {
  const first = new DebateSession(new FakeAgent());
  const second = new DebateSession(new FakeAgent());
  await first.prepare("First");
  await first.choose("affirmative");
  assert.equal(second.snapshot.status, "topic_entry");
  assert.equal(second.snapshot.messages.length, 0);
  assert.notEqual(first.snapshot.id, second.snapshot.id);
});

test("positions require exactly two distinct claims rather than questions", () => {
  assert.deepEqual(parsePositions(JSON.stringify(POSITIONS)), POSITIONS);
  assert.deepEqual(parsePositions("```json\n" + JSON.stringify(POSITIONS) + "\n```"), POSITIONS);
  for (const data of [null, [], {}, { ...POSITIONS, third: "extra" }, { ...POSITIONS, negative: "Why allow AI?" }, { ...POSITIONS, negative: POSITIONS.affirmative }, { ...POSITIONS, motion: "" }]) {
    assert.throws(() => parsePositions(JSON.stringify(data)));
  }
  assert.throws(() => parsePositions("not json"));
});

const judgment: ArgumentJudgment = { score: 76, rationale: "Clear claim; explain the causal link more fully.", breakdown: speechBreakdown(76), criteria: "Provisional", provisional: true };

test("practice judges generated and human speeches using only prior transcript and assigned side", async () => {
  for (const humanSide of ["affirmative", "negative"] as const) {
    const calls: ArgumentJudgeInput[] = [];
    const evaluator: ArgumentJudge = { judge: async input => { calls.push(input); return judgment; }, dispose: async () => {} };
    const agent = new FakeAgent();
    const session = new DebateSession(agent, undefined, undefined, evaluator);
    await session.prepare("Learning");
    await session.choose(humanSide);
    await session.respond("Reviewed speech transcription.");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0]?.messages, []);
    assert.equal(calls[0]?.side, session.snapshot.assistantSide);
    assert.equal(calls[1]?.side, humanSide);
    assert.equal(calls[1]?.text, "Reviewed speech transcription.");
    assert.deepEqual(calls[1]?.messages.map(message => message.text), ["Opening arguments"]);
    assert.deepEqual(calls[2]?.messages.map(message => message.text), ["Opening arguments", "Reviewed speech transcription."]);
    assert.ok(session.snapshot.messages.every(message => message.judgment?.score === 76));
    assert.doesNotMatch(JSON.stringify(agent.calls[0]?.context), /judgment|causal link/);
    const snapshot = session.snapshot;
    snapshot.messages[0]!.judgment!.score = 0;
    assert.equal(session.snapshot.messages[0]?.judgment?.score, 76);
    await assert.rejects(session.judge(0), /already been judged/);
  }
});

test("failed judging retains speeches, allows continuation, and retries only the chosen evaluation", async () => {
  const calls: ArgumentJudgeInput[] = [];
  let fail = true;
  const evaluator: ArgumentJudge = { judge: async input => {
    calls.push(input);
    if (fail) throw new Error("fixture-secret raw provider failure");
    return judgment;
  }, dispose: async () => {} };
  const agent = new FakeAgent();
  const session = new DebateSession(agent, undefined, undefined, evaluator);
  await session.prepare("Learning");
  await session.choose("affirmative");
  assert.equal(session.snapshot.status, "active");
  assert.equal(session.snapshot.pending, null);
  assert.match(session.snapshot.messages[0]?.judgmentError ?? "", /failed/);
  assert.doesNotMatch(JSON.stringify(session.snapshot), /fixture-secret/);
  await session.respond("My human speech.");
  assert.equal(session.snapshot.messages.length, 3);
  assert.ok(session.snapshot.messages.every(message => message.judgmentError && !message.judgment));
  const saved = session.snapshot.messages.map(({ role, text }) => ({ role, text }));
  fail = false;
  await session.judge(1);
  assert.equal(calls.length, 4);
  assert.equal(agent.calls.length, 1);
  assert.deepEqual(session.snapshot.messages.map(({ role, text }) => ({ role, text })), saved);
  assert.equal(session.snapshot.messages[1]?.judgment?.score, 76);
  assert.equal(session.snapshot.messages[1]?.judgmentError, undefined);
  assert.ok(session.snapshot.messages[0]?.judgmentError);
  for (const invalid of [-1, 0.5, NaN, Infinity, 3]) await assert.rejects(session.judge(invalid), /existing speech/);
  agent.fail = true;
  await assert.rejects(session.respond("Pending human speech."));
  assert.equal(calls.length, 4);
  await assert.rejects(session.judge(0), /pending response/);
});

test("ending during judging keeps committed speeches and suppresses late evaluations", async () => {
  let release!: (value: ArgumentJudgment) => void;
  let started!: () => void;
  let judgeSignal: AbortSignal | undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const evaluator: ArgumentJudge = { judge: async (_input, signal) => {
    judgeSignal = signal;
    started();
    return new Promise(resolve => { release = resolve; });
  }, dispose: async () => {} };
  const session = new DebateSession(new FakeAgent(), undefined, undefined, evaluator);
  await session.prepare("Learning");
  const opening = session.choose("affirmative");
  await ready;
  assert.equal(session.snapshot.status, "generating_judgment");
  assert.equal(session.snapshot.messages[0]?.text, "Opening arguments");
  assert.equal(session.snapshot.pending, null);
  await assert.rejects(session.respond("Concurrent"), /unavailable/);
  await assert.rejects(session.judge(0), /unavailable/);
  session.end();
  assert.equal(judgeSignal?.aborted, true);
  release(judgment);
  await opening;
  assert.equal(session.snapshot.status, "ended");
  assert.equal(session.snapshot.messages.length, 1);
  assert.equal(session.snapshot.messages[0]?.judgment, undefined);
  assert.equal(session.snapshot.messages[0]?.judgmentError, undefined);
});
