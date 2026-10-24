import { test } from "node:test";
import assert from "node:assert/strict";
import { DebateSession, parsePositions, type DebateAgent, type PracticeContext } from "../src/debate.js";
import { POSITIONS } from "./fixture.js";

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
