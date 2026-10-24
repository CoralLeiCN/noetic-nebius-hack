import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { providerFixture, POSITIONS, speechBreakdown } from "./fixture.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("CLI judges both speakers, retries a failed judgment, starts a new session, and quits", { timeout: 60_000 }, async () => {
  let argumentsGenerated = 0;
  let judgments = 0;
  const fixture = await providerFixture(request => {
    if (JSON.stringify(request.body.text ?? {}).includes('"score"')) {
      judgments++;
      return judgments === 1 ? "invalid judge output" : JSON.stringify({ breakdown: speechBreakdown(76), rationale: "Clear claims; explain the causal mechanism more fully." });
    }
    if (JSON.stringify(request.body.input).includes("Create one debate motion")) return JSON.stringify(POSITIONS);
    return `CLI argument ${++argumentsGenerated}`;
  });
  const child = spawn(process.execPath, [cliPath], {
    env: { ...process.env, NEBIUS_BASE_URL: fixture.baseUrl, NEBIUS_API_KEY: "fixture-secret", NEBIUS_MODEL: "fixture-model" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  async function waitFor(text: string) {
    const deadline = Date.now() + 45_000;
    while (!output.includes(text)) {
      if (Date.now() > deadline || child.exitCode !== null) assert.fail(`CLI did not produce ${text}. Output: ${output}`);
      await delay(20);
    }
  }
  try {
    await waitFor("Enter a topic to begin.");
    child.stdin.write("AI in education\n");
    await waitFor("Motion: Schools should allow AI for homework.");
    child.stdin.write("a\n");
    await waitFor("CLI argument 1");
    assert.match(output, /You: affirmative \| Assistant: negative/);
    await waitFor("Use /judge 1 to retry.");
    child.stdin.write("/judge 0\n");
    await waitFor("Use /judge <turn> with a positive turn number.");
    child.stdin.write("/judge 1\n");
    await waitFor("Assistant, turn 1 — provisional score: 76/100");
    assert.equal(argumentsGenerated, 1);
    assert.equal(output.match(/CLI argument 1/g)?.length, 1);
    child.stdin.write("AI helps students learn.\n");
    await waitFor("CLI argument 2");
    await waitFor("You, turn 2 — provisional score: 76/100");
    await waitFor("Assistant, turn 3 — provisional score: 76/100");
    child.stdin.write("/new\n");
    await waitFor("Enter a new topic.");
    child.stdin.write("/quit\n");
    const [code] = await exited;
    assert.equal(code, 0, output);
    assert.equal(fixture.requests.length, 7);
    assert.equal(judgments, 4);
    assert.equal(argumentsGenerated, 2);
    assert.equal(output.match(/CLI argument 1/g)?.length, 1);
    assert.equal(output.match(/CLI argument 2/g)?.length, 1);
    assert.doesNotMatch(output, /fixture-secret/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await fixture.close();
  }
});

for (const command of ["/end", "/new", "/quit"]) {
  test(`CLI keeps a committed speech visible when ${command} cancels judging`, { timeout: 60_000 }, async () => {
    let release!: (text: string) => void;
    const pending = new Promise<string>(resolve => { release = resolve; });
    let requested!: () => void;
    const received = new Promise<void>(resolve => { requested = resolve; });
    const fixture = await providerFixture(request => {
      if (JSON.stringify(request.body.text ?? {}).includes('"score"')) { requested(); return pending; }
      if (JSON.stringify(request.body.input).includes("Create one debate motion")) return JSON.stringify(POSITIONS);
      return "The completed opening must remain visible.";
    });
    const child = spawn(process.execPath, [cliPath], {
      env: { ...process.env, NEBIUS_BASE_URL: fixture.baseUrl, NEBIUS_API_KEY: "fixture-secret", NEBIUS_MODEL: "fixture-model" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    async function waitFor(text: string) {
      const deadline = Date.now() + 45_000;
      while (!output.includes(text)) {
        if (Date.now() > deadline || child.exitCode !== null) assert.fail(`CLI did not produce ${text}. Output: ${output}`);
        await delay(20);
      }
    }
    try {
      await waitFor("Enter a topic to begin.");
      child.stdin.write("AI\n");
      await waitFor("Motion: Schools should allow AI for homework.");
      child.stdin.write("a\n");
      await received;
      child.stdin.write(`${command}\n`);
      await waitFor("The completed opening must remain visible.");
      release(JSON.stringify({ breakdown: speechBreakdown(99), rationale: "Late judgment must be ignored." }));
      if (command !== "/quit") {
        await waitFor(command === "/end" ? "Session ended." : "Enter a new topic.");
        child.stdin.write("/quit\n");
      }
      const [code] = await exited;
      assert.equal(code, 0, output);
      assert.equal(output.match(/The completed opening must remain visible\./g)?.length, 1);
      assert.doesNotMatch(output, /Late judgment must be ignored|provisional score: 99/);
    } finally {
      release(JSON.stringify({ breakdown: speechBreakdown(99), rationale: "Late judgment must be ignored." }));
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      await fixture.close();
    }
  });
}

test("CLI can end a running SDK generation and ignores its late response", { timeout: 60_000 }, async () => {
  let release!: (text: string) => void;
  const pending = new Promise<string>(resolve => { release = resolve; });
  let requested!: () => void;
  const received = new Promise<void>(resolve => { requested = resolve; });
  const fixture = await providerFixture(() => { requested(); return pending; });
  const child = spawn(process.execPath, [cliPath], {
    env: { ...process.env, NEBIUS_BASE_URL: fixture.baseUrl, NEBIUS_API_KEY: "fixture-secret", NEBIUS_MODEL: "fixture-model" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  try {
    // Wait for startup before submitting input, then cancel after the SDK
    // actually reaches the endpoint rather than merely after a UI update.
    while (!output.includes("Enter a topic to begin.")) await delay(20);
    child.stdin.write("AI\n");
    await received;
    child.stdin.write("/end\n");
    while (!output.includes("Session ended.")) await delay(20);
    release(JSON.stringify(POSITIONS));
    child.stdin.write("/quit\n");
    const [code] = await exited;
    assert.equal(code, 0, output);
    assert.doesNotMatch(output, /Motion:/);
  } finally {
    release(JSON.stringify(POSITIONS));
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await fixture.close();
  }
});
