import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

const launcher = pathToFileURL(fileURLToPath(new URL("../src/start-web.js", import.meta.url))).href;
const speechFixture = `
import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
const server = createServer((request, response) => {
  const ready = existsSync("speech.ready");
  response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ ready, models: [{ task: "asr", ready }] }));
});
server.listen(Number(process.env.SPEECH_PORT), "127.0.0.1", () => {
  writeFileSync("speech.started", JSON.stringify({ port: process.env.SPEECH_PORT, pid: process.pid }));
  if (process.env.FIXTURE_SPEECH_FAIL) setTimeout(() => process.exit(7), 60);
});
process.on("SIGTERM", () => {
  writeFileSync("speech.stopped", "stopped");
  server.closeAllConnections();
  server.close();
});
`;
const webFixture = `
import { writeFileSync } from "node:fs";
writeFileSync("web.started", "started");
const timer = setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  writeFileSync("web.stopped", "stopped");
  clearInterval(timer);
});
if (process.env.FIXTURE_WEB_FAIL) setTimeout(() => process.exit(9), 60);
`;

async function exists(path: string) {
  try { await access(path); return true; } catch { return false; }
}

async function waitFor(check: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${description}.`);
    await delay(15);
  }
}

async function speechServer(t: TestContext, initiallyReady = true) {
  let ready = initiallyReady;
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ready, models: [{ task: "asr", ready }] }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No speech fixture port.");
  return { origin: `http://127.0.0.1:${address.port}`, setReady: () => { ready = true; }, requests: () => requests };
}

async function unusedOrigin() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No available speech port.");
  await new Promise<void>(done => server.close(() => done()));
  return `http://127.0.0.1:${address.port}`;
}

async function supervisor(t: TestContext, origin: string, env: NodeJS.ProcessEnv = {}, startupTimeoutMs = 3000) {
  const root = await mkdtemp(join(tmpdir(), "debate-start-web-"));
  const options = {
    root,
    env: { ...env, SPEECH_SERVICE_URL: origin },
    speechCommand: { file: process.execPath, args: ["--input-type=module", "-e", speechFixture] },
    webCommand: { file: process.execPath, args: ["--input-type=module", "-e", webFixture] },
    startupTimeoutMs,
    pollIntervalMs: 20,
  };
  const script = `import { startWeb } from ${JSON.stringify(launcher)};
startWeb(${JSON.stringify(options)}).catch(error => { console.error(error.message); process.exitCode = 1; });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  return {
    child, exited, root,
    output: () => output,
    has: (name: string) => exists(join(root, name)),
    wait: (name: string) => waitFor(() => exists(join(root, name)), `${name}; output: ${output}`),
    ready: () => writeFile(join(root, "speech.ready"), "ready"),
  };
}

test("web startup waits for managed speech readiness, derives its custom port, and stops both children", { timeout: 10_000 }, async t => {
  const origin = await unusedOrigin();
  const run = await supervisor(t, origin);
  await run.wait("speech.started");
  const started = JSON.parse(await readFile(join(run.root, "speech.started"), "utf8"));
  assert.equal(started.port, new URL(origin).port);
  await delay(80);
  assert.equal(await run.has("web.started"), false, "Web must not start while speech reports not ready.");
  await run.ready();
  await run.wait("web.started");
  run.child.kill("SIGTERM");
  const [code] = await run.exited;
  assert.equal(code, 0, run.output());
  assert.equal(await run.has("speech.stopped"), true);
  assert.equal(await run.has("web.stopped"), true);
  await assert.rejects(fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) }));
});

test("web startup reuses an existing starting speech service and leaves it running on exit", { timeout: 10_000 }, async t => {
  const service = await speechServer(t, false);
  const run = await supervisor(t, service.origin);
  await waitFor(() => service.requests() >= 2, "existing speech health checks");
  assert.equal(await run.has("speech.started"), false);
  assert.equal(await run.has("web.started"), false);
  service.setReady();
  await run.wait("web.started");
  run.child.kill("SIGTERM");
  const [code] = await run.exited;
  assert.equal(code, 0, run.output());
  assert.equal(await run.has("web.stopped"), true);
  assert.equal((await fetch(`${service.origin}/health`)).status, 200);
  assert.match(run.output(), /Using the existing speech service/);
});

test("web child failure stops the managed speech service", { timeout: 10_000 }, async t => {
  const run = await supervisor(t, await unusedOrigin(), { FIXTURE_WEB_FAIL: "1" });
  await run.ready();
  const [code] = await run.exited;
  assert.equal(code, 1, run.output());
  assert.match(run.output(), /Web server exited \(9\)/);
  assert.equal(await run.has("speech.stopped"), true);
});

test("speech child failure prevents web startup", { timeout: 10_000 }, async t => {
  const run = await supervisor(t, await unusedOrigin(), { FIXTURE_SPEECH_FAIL: "1" });
  const [code] = await run.exited;
  assert.equal(code, 1, run.output());
  assert.match(run.output(), /Speech launcher exited \(7\)/);
  assert.equal(await run.has("web.started"), false);
});

test("speech readiness timeout stops owned speech without starting the web app", { timeout: 10_000 }, async t => {
  const run = await supervisor(t, await unusedOrigin(), {}, 160);
  const [code] = await run.exited;
  assert.equal(code, 1, run.output());
  assert.match(run.output(), /Speech did not become ready.*speech:setup/);
  assert.equal(await run.has("speech.started"), true);
  assert.equal(await run.has("speech.stopped"), true);
  assert.equal(await run.has("web.started"), false);
});

test("managed startup rejects mismatched speech URL and port before spawning services", { timeout: 10_000 }, async t => {
  const origin = await unusedOrigin();
  const port = Number(new URL(origin).port);
  const run = await supervisor(t, origin, { SPEECH_PORT: String(port === 65535 ? port - 1 : port + 1) });
  const [code] = await run.exited;
  assert.equal(code, 1, run.output());
  assert.match(run.output(), /SPEECH_PORT must match SPEECH_SERVICE_URL/);
  assert.equal(await run.has("speech.started"), false);
  assert.equal(await run.has("web.started"), false);
});
