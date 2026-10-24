import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexDebateAgent } from "../src/codex-agent.js";
import { DebateSession } from "../src/debate.js";
import { publicError } from "../src/errors.js";
import { providerFixture, POSITIONS } from "./fixture.js";

test("GLM 5.3 Flash sends low reasoning effort through the actual Responses request", { timeout: 30_000 }, async () => {
  const fixture = await providerFixture(() => JSON.stringify(POSITIONS));
  const agent = await CodexDebateAgent.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "zai-org/GLM-5.3-Flash" });
  try {
    await agent.prepare("AI in education", new AbortController().signal);
    assert.equal(fixture.requests.length, 1);
    assert.equal((fixture.requests[0]!.body.reasoning as { effort?: string } | undefined)?.effort, "low");
  } finally { await agent.dispose(); await fixture.close(); }
});

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
    assert.doesNotMatch(JSON.stringify(fixture.requests[0]?.body.input), /# Persona: Direct parliamentary debater|TASK: SPEECH/);
    for (const request of fixture.requests.slice(1)) {
      const input = JSON.stringify(request.body.input);
      assert.match(input, /# Persona: Direct parliamentary debater/);
      assert.match(input, /How to build a speech/);
      assert.match(input, /TASK: SPEECH/);
      assert.match(input, /None supplied\. Use the style guidance above/);
      assert.doesNotMatch(input, /\{SOURCE_EXCERPTS\}/);
      assert.match(input, /parliamentary style and its guardrails take priority/);
    }
    const openingInput = JSON.stringify(fixture.requests[1]?.body.input);
    assert.match(openingInput, /Speech name: negative opening speech/);
    assert.match(openingInput, /Word budget: at most 250 words/);
    assert.match(finalInput, /Speech name: negative rebuttal \/ POI answer/);
    assert.match(finalInput, /Word budget: at most 180 words/);
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
    assert.doesNotMatch(JSON.stringify(fixture.requests), /# Persona: Direct parliamentary debater|TASK: SPEECH/);
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
    index >= 2 && index <= 4 ? { status: 503, body: '{"error":{"message":"unavailable"}}' } : `Argument ${index}`);
  const agent = await CodexDebateAgent.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "fixture-model" });
  try {
    const session = new DebateSession(agent);
    await session.prepare("AI");
    await session.choose("negative");
    const oldThread = agent.threadIds.practice;
    await assert.rejects(session.respond("My learning argument"), error => {
      assert.match(publicError(error), /provider is temporarily unavailable/);
      assert.doesNotMatch(publicError(error), /fixture-secret|unavailable\"/);
      return true;
    });
    assert.equal(fixture.requests.length, 5, "a persistent 503 gets exactly three HTTP attempts");
    assert.equal(session.snapshot.messages.length, 1);
    assert.deepEqual(session.snapshot.pending, { kind: "reply", contribution: "My learning argument" });
    assert.equal(agent.threadIds.practice, null);
    await session.retry();
    assert.notEqual(agent.threadIds.practice, oldThread);
    assert.equal(session.snapshot.messages.length, 3);
    const input = JSON.stringify(fixture.requests.at(-1)?.body.input);
    assert.equal(input.match(/My learning argument/g)?.length, 1);
    assert.match(input, /Argument 1/);
    assert.match(input, /humanSide.*negative/);
    assert.match(input, /# Persona: Direct parliamentary debater/);
    assert.match(input, /Speech name: affirmative rebuttal \/ POI answer/);
    assert.doesNotMatch(input, /\{SOURCE_EXCERPTS\}/);
  } finally { await agent.dispose(); await fixture.close(); }
});

test("actual SDK recovers a transient provider 503 within the same request", { timeout: 60_000 }, async () => {
  const fixture = await providerFixture((_request, index) => index === 0
    ? { status: 503, body: '{"error":{"message":"temporary unavailability"}}' }
    : JSON.stringify(POSITIONS));
  const agent = await CodexDebateAgent.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "fixture-model" });
  try {
    assert.deepEqual(await agent.prepare("AI", new AbortController().signal), POSITIONS);
    assert.equal(fixture.requests.length, 2);
    assert.deepEqual(fixture.requests[0]?.body, fixture.requests[1]?.body);
  } finally { await agent.dispose(); await fixture.close(); }
});

test("aborting generation stops unavailable-provider retries", { timeout: 60_000 }, async () => {
  const controller = new AbortController();
  let cancel: ReturnType<typeof setTimeout> | undefined;
  const fixture = await providerFixture(() => {
    cancel ??= setTimeout(() => controller.abort(new Error("Canceled test generation")), 25);
    return { status: 503, body: '{"error":{"message":"temporary unavailability"}}' };
  });
  const agent = await CodexDebateAgent.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "fixture-model" }, undefined,
    { requestTimeoutMs: 300_000 });
  try {
    await assert.rejects(agent.prepare("AI", controller.signal));
    assert.equal(controller.signal.aborted, true);
    assert.equal(fixture.requests.length, 1);
  } finally { clearTimeout(cancel); await agent.dispose(); await fixture.close(); }
});

test("a custom request deadline aborts a stalled provider and allows a fresh retry", { timeout: 15_000 }, async () => {
  let release!: (text: string) => void;
  const stalled = new Promise<string>(resolve => { release = resolve; });
  const fixture = await providerFixture((_request, index) => index === 0 ? stalled : JSON.stringify(POSITIONS));
  const agent = await CodexDebateAgent.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "fixture-model" }, undefined,
    { requestTimeoutMs: 1500 });
  try {
    await assert.rejects(agent.prepare("AI", new AbortController().signal), /Generation timed out after 1.5 seconds/);
    assert.equal(fixture.requests.length, 1, "The deadline aborts the request without an automatic generation replay.");
    release(JSON.stringify(POSITIONS));
    assert.deepEqual(await agent.prepare("AI", new AbortController().signal), POSITIONS);
    assert.equal(fixture.requests.length, 2);
  } finally { release(JSON.stringify(POSITIONS)); await agent.dispose(); await fixture.close(); }
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

test("Responses history validation falls back once to confirmed transcript and keeps subsequent turns compatible", { timeout: 60_000 }, async () => {
  const fixture = await providerFixture((_request, index) => index === 0 ? JSON.stringify(POSITIONS) :
    index === 2 ? { status: 400, body: JSON.stringify({ error: { message: "ChatCompletionRequest validation: output_text should be a valid string; fixture-secret" } }) } : `Argument ${index}`);
  const agent = await CodexDebateAgent.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "fixture-model" });
  try {
    const session = new DebateSession(agent);
    await session.prepare("AI");
    await session.choose("affirmative");
    await session.respond("First learning benefit");
    await session.respond("Second learning benefit");
    assert.equal(fixture.requests.length, 5);
    assert.equal(session.snapshot.messages.length, 5);
    for (const index of [3, 4]) {
      const input = JSON.stringify(fixture.requests[index]?.body.input);
      assert.match(input, /Argument 1/);
      assert.equal(input.match(/First learning benefit/g)?.length, 1);
      assert.doesNotMatch(input, /fixture-secret/);
      assert.match(input, /# Persona: Direct parliamentary debater/);
      assert.match(input, /Word budget: at most 180 words/);
      assert.doesNotMatch(input, /\{SOURCE_EXCERPTS\}/);
      const messages = fixture.requests[index]!.body.input as { role?: string }[];
      assert.equal(messages.some(message => message.role === "assistant"), false);
    }
    assert.match(JSON.stringify(fixture.requests[4]?.body.input), /Argument 3/);
    assert.equal(JSON.stringify(fixture.requests[4]?.body.input).match(/Second learning benefit/g)?.length, 1);
  } finally { await agent.dispose(); await fixture.close(); }
});

test("history compatibility fallback is bounded when a fresh request also fails", { timeout: 60_000 }, async () => {
  const fixture = await providerFixture((_request, index) => index === 0 ? JSON.stringify(POSITIONS) : index === 1 ? "Opening" :
    { status: 400, body: JSON.stringify({ error: { message: "ChatCompletionRequest validation output_text" } }) });
  const agent = await CodexDebateAgent.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "fixture-model" });
  try {
    const session = new DebateSession(agent);
    await session.prepare("AI"); await session.choose("affirmative");
    await assert.rejects(session.respond("My point"));
    assert.equal(fixture.requests.length, 4);
    assert.equal(session.snapshot.messages.length, 1);
    assert.equal(session.snapshot.pending?.kind, "reply");
  } finally { await agent.dispose(); await fixture.close(); }
});

test("position content repair tolerates a gateway that rejects resumed Responses history", { timeout: 60_000 }, async () => {
  const fixture = await providerFixture((_request, index) => index === 0 ? "Invalid position output" : index === 1 ?
    { status: 400, body: JSON.stringify({ error: { message: "ChatCompletionRequest validation output_text" } }) } : JSON.stringify(POSITIONS));
  const agent = await CodexDebateAgent.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "fixture-model" });
  try {
    assert.deepEqual(await agent.prepare("AI", new AbortController().signal), POSITIONS);
    assert.equal(fixture.requests.length, 3);
    const input = JSON.stringify(fixture.requests[2]?.body.input);
    assert.match(input, /Topic data.*AI/);
    assert.match(input, /Invalid position output/);
    assert.match(input, /Repair the prior output/);
    assert.equal((fixture.requests[2]!.body.input as {role?:string}[]).some(message => message.role === "assistant"), false);
  } finally { await agent.dispose(); await fixture.close(); }
});
