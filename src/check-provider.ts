import { loadConfig } from "./config.js";
import { CodexDebateAgent } from "./codex-agent.js";
import { DebateSession } from "./debate.js";
import { publicError } from "./errors.js";

let agent: CodexDebateAgent | undefined;
const signal = new AbortController();
const stop = () => signal.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const config = loadConfig();
  agent = await CodexDebateAgent.create(config);
  signal.signal.throwIfAborted();
  const session = new DebateSession(agent);
  signal.signal.addEventListener("abort", () => session.end(), { once: true });
  console.log("Checking the configured provider through the Codex SDK (uses model credits)...");
  await session.prepare("Whether schools should allow AI assistance with homework");
  signal.signal.throwIfAborted();
  console.log("PASS: motion and opposing positions");
  await session.choose("affirmative");
  signal.signal.throwIfAborted();
  console.log("PASS: opening arguments");
  await session.respond("AI can explain difficult concepts. Why should schools restrict a useful learning aid?");
  signal.signal.throwIfAborted();
  await session.respond("How does your position address the learning benefit I raised in my previous response?");
  signal.signal.throwIfAborted();
  console.log("PASS: two follow-up turns completed on the practice thread");
  console.log("\nReview the model output for opposing positions, side consistency, and contextual relevance:");
  const snapshot = session.snapshot;
  console.log(JSON.stringify({ positions: snapshot.positions, humanSide: snapshot.humanSide, assistantSide: snapshot.assistantSide, messages: snapshot.messages }, null, 2));
  session.end();
} catch (error) {
  console.error(signal.signal.aborted ? "Provider check cancelled." : publicError(error));
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await agent?.dispose();
}
