import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { providerFixture, POSITIONS } from "./fixture.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("CLI completes topic, side selection, response, new session, and quit", { timeout: 60_000 }, async () => {
  const fixture = await providerFixture((_request, index) => index === 0 ? JSON.stringify(POSITIONS) : `CLI argument ${index}`);
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
    child.stdin.write("AI helps students learn.\n");
    await waitFor("CLI argument 2");
    child.stdin.write("/new\n");
    await waitFor("Enter a new topic.");
    child.stdin.write("/quit\n");
    const [code] = await exited;
    assert.equal(code, 0, output);
    assert.equal(fixture.requests.length, 3);
    assert.doesNotMatch(output, /fixture-secret/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await fixture.close();
  }
});

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
