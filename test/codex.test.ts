import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexDebateAgent } from "../src/codex-agent.js";
import { DebateSession } from "../src/debate.js";
import { publicError } from "../src/errors.js";
import { providerFixture, POSITIONS } from "./fixture.js";

test("real Codex SDK routes preparation and contextual practice to a custom Responses endpoint", { timeout: 60_000 }, async () => {
  const fixture = await providerFixture((_request, index) => index === 0 ? JSON.stringify(POSITIONS) : `Assistant argument ${index}`);
  const agent = await CodexDebateAgent.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "fixture-model" });
  try {
    const session = new DebateSession(agent);
    await session.prepare("AI in education");
    await session.choose("affirmative");
    const practiceId = agent.threadIds.practice;
    await session.respond("AI helps students learn.");
    await session.respond("Address my earlier learning benefit.");
    assert.equal(agent.threadIds.practice, practiceId);
    assert.notEqual(agent.threadIds.preparation, practiceId);
    assert.equal(session.snapshot.messages.length, 5);
    assert.equal(fixture.requests.length, 4);
    for (const request of fixture.requests) {
      assert.equal(request.path, "/custom/v1/responses");
      assert.equal(request.headers.authorization, "Bearer fixture-secret");
      assert.equal(request.body.model, "fixture-model");
      assert.equal(request.body.stream, true);
      const tools = JSON.stringify(request.body.tools ?? []);
      assert.doesNotMatch(tools, /"name":"(?:shell|exec_command|spawn_agent|mcp__|write_stdin|view_image|apply_patch)/);
      assert.doesNotMatch(JSON.stringify(request.body), /fixture-secret/);
      assert.match(JSON.stringify(request.body.input), /debate practice partner/);
      assert.doesNotMatch(JSON.stringify(request.body.input), /Available skills/);
    }
    const finalInput = JSON.stringify(fixture.requests.at(-1)?.body.input);
    assert.match(finalInput, /AI helps students learn/);
    assert.match(finalInput, /Assistant argument 1/);
    assert.match(finalInput, /assistantSide.*negative/);
    session.end();
  } finally { await agent.dispose(); await fixture.close(); }
});

test("invalid position output gets only one content repair", { timeout: 60_000 }, async () => {
  const fixture = await providerFixture(() => "This is not JSON.");
  const agent = await CodexDebateAgent.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "fixture-model" });
  try {
    await assert.rejects(agent.prepare("AI", new AbortController().signal), /valid positions/);
    assert.equal(fixture.requests.length, 2);
    assert.match(JSON.stringify(fixture.requests[1]?.body.input), /Repair the prior output/);
  } finally { await agent.dispose(); await fixture.close(); }
});

test("incompatible Responses endpoint fails clearly without content retries", { timeout: 60_000 }, async () => {
  const fixture = await providerFixture(() => ({ status: 404, body: '{"error":{"message":"Responses unavailable"}}' }));
  const agent = await CodexDebateAgent.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "fixture-model" });
  try {
    await assert.rejects(agent.prepare("AI", new AbortController().signal), error => {
      assert.match(publicError(error), /Responses compatibility/);
      return true;
    });
    assert.equal(fixture.requests.length, 1);
  } finally { await agent.dispose(); await fixture.close(); }
});

test("SDK failure rebuilds practice history from confirmed messages on retry", { timeout: 60_000 }, async () => {
  const fixture = await providerFixture((_request, index) => index === 0 ? JSON.stringify(POSITIONS) :
    index === 2 ? { status: 503, body: '{"error":{"message":"unavailable"}}' } : `Argument ${index}`);
  const agent = await CodexDebateAgent.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "fixture-model" });
  try {
    const session = new DebateSession(agent);
    await session.prepare("AI");
    await session.choose("negative");
    const oldThread = agent.threadIds.practice;
    await assert.rejects(session.respond("My learning argument"));
    assert.equal(agent.threadIds.practice, null);
    await session.retry();
    assert.notEqual(agent.threadIds.practice, oldThread);
    assert.equal(session.snapshot.messages.length, 3);
    const input = JSON.stringify(fixture.requests.at(-1)?.body.input);
    assert.equal(input.match(/My learning argument/g)?.length, 1);
    assert.match(input, /Argument 1/);
    assert.match(input, /humanSide.*negative/);
  } finally { await agent.dispose(); await fixture.close(); }
});

test("actual SDK authentication failures are sanitized with no provider fallback", { timeout: 60_000 }, async () => {
  const fixture = await providerFixture(() => ({ status: 401, body: JSON.stringify({ error: { message: "bad fixture-secret credential", type: "authentication_error" } }) }));
  const agent = await CodexDebateAgent.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "fixture-model" });
  try {
    await assert.rejects(agent.prepare("AI", new AbortController().signal), error => {
      assert.match(publicError(error), /authentication/);
      assert.doesNotMatch(publicError(error), /fixture-secret/);
      return true;
    });
    assert.equal(fixture.requests.length, 1);
  } finally { await agent.dispose(); await fixture.close(); }
});
