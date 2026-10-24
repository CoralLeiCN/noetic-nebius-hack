import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { speechOrigin } from "./speech.js";

interface Command { file: string; args: string[] }
interface StartWebOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  speechCommand?: Command;
  webCommand?: Command;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
}

// Health checks only inspect local readiness; they never generate speech.
async function speechHealth(origin: string): Promise<boolean | null> {
  let response: Response;
  try {
    response = await fetch(`${origin}/health`, { redirect: "error", signal: AbortSignal.timeout(2500) });
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ECONNREFUSED") return null;
    throw new Error(`Could not check speech readiness at ${origin}. Check SPEECH_SERVICE_URL and the existing service.`);
  }
  const result: unknown = await response.json().catch(() => null);
  if (![200, 503].includes(response.status) || !result || typeof result !== "object" ||
    !("ready" in result) || typeof result.ready !== "boolean" || !("models" in result) || !Array.isArray(result.models)) {
    throw new Error(`The service at ${origin} did not return a speech health response. Check SPEECH_SERVICE_URL.`);
  }
  return response.ok && result.ready;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise<void>(done => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 20_000);
    child.once("exit", () => { clearTimeout(timer); done(); });
    child.kill("SIGTERM");
  });
}

export async function startWeb(options: StartWebOptions = {}): Promise<void> {
  const root = options.root ?? process.cwd();
  const env = options.env ?? process.env;
  const origin = speechOrigin(env.SPEECH_SERVICE_URL ?? "http://127.0.0.1:8764", "SPEECH_SERVICE_URL");
  const children: ChildProcess[] = [];
  const stopped = new AbortController();
  let userStopped = false;
  let cleaningUp = false;
  const onSignal = () => {
    userStopped = true;
    stopped.abort(new Error("Startup stopped."));
  };
  const launch = (name: string, command: Command, environment: NodeJS.ProcessEnv) => {
    const child = spawn(command.file, command.args, { cwd: root, env: environment, stdio: "inherit" });
    children.push(child);
    child.once("error", () => stopped.abort(new Error(`Could not launch ${name}. Check that ${command.file} is installed.`)));
    child.once("exit", (code, signal) => {
      if (!cleaningUp) stopped.abort(new Error(`${name} exited (${signal ?? code}). See the service output above.`));
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    let ready = await speechHealth(origin);
    stopped.signal.throwIfAborted();
    if (ready === null) {
      const url = new URL(origin);
      const port = Number(env.SPEECH_PORT ?? (url.port || "80"));
      if (!Number.isInteger(port) || port < 1 || port > 65535 || port !== Number(url.port || "80") || url.hostname === "[::1]") {
        throw new Error("SPEECH_PORT must match SPEECH_SERVICE_URL, using 127.0.0.1 or localhost for managed speech startup.");
      }
      console.log(`Starting speech at ${origin}…`);
      launch("Speech launcher", options.speechCommand ?? {
        file: "python3", args: ["scripts/local-speech.py", "start", ...process.argv.slice(2)],
      }, { ...env, SPEECH_PORT: String(port) });
    } else {
      console.log(`Using the existing speech service at ${origin}.`);
    }
    const deadline = Date.now() + (options.startupTimeoutMs ?? 120_000);
    while (!ready) {
      stopped.signal.throwIfAborted();
      if (Date.now() >= deadline) throw new Error(`Speech did not become ready at ${origin}. Check the worker output or run npm run speech:setup.`);
      await delay(options.pollIntervalMs ?? 500, undefined, { signal: stopped.signal });
      ready = await speechHealth(origin);
    }
    stopped.signal.throwIfAborted();
    console.log("Speech is ready. Starting the web app. Ctrl+C stops services started by this command.");
    launch("Web server", options.webCommand ?? {
      file: process.execPath, args: ["--env-file-if-exists=.env", "dist/src/server.js"],
    }, env);
    await new Promise<void>(done => {
      if (stopped.signal.aborted) done();
      else stopped.signal.addEventListener("abort", () => done(), { once: true });
    });
    stopped.signal.throwIfAborted();
  } catch (error) {
    if (!userStopped) throw stopped.signal.aborted ? stopped.signal.reason : error;
  } finally {
    cleaningUp = true;
    await Promise.all(children.map(stopChild));
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startWeb().catch(error => {
    console.error(error instanceof Error ? error.message : "Could not start the web app and speech services.");
    process.exitCode = 1;
  });
}
