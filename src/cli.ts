import { createInterface } from "node:readline";
import { loadConfig } from "./config.js";
import { CodexDebateAgent } from "./codex-agent.js";
import { CodexArgumentJudge } from "./argument-judge.js";
import { DebateSession, type Message } from "./debate.js";
import { publicError } from "./errors.js";

const HELP = `Debate practice
Enter a topic, review the opposing positions, then choose a side.
Commands:
  /affirmative, /negative   Choose your side (or enter a / n)
  /regenerate              Generate new positions for the current topic
  /topic <topic>           Replace the topic before choosing a side
  /retry                   Retry the failed generation
  /judge <turn>            Retry judging a speech (turns start at 1)
  /end                     End this session, including active generation
  /new                     Start another session
  /quit                    Exit
  /help                    Show these commands
During practice, enter your argument or question as a line of text.
Ctrl+C cancels generation and exits. Only completed responses are displayed.`;

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  const config = loadConfig();
  const agent = await CodexDebateAgent.create(config);
  let judge: CodexArgumentJudge;
  try { judge = await CodexArgumentJudge.create(config); }
  catch (error) { await agent.dispose(); throw error; }
  let session = new DebateSession(agent, undefined, undefined, judge);
  const printedMessages = new WeakMap<DebateSession, number>();
  function printJudgment(message: Message, index: number, canRetry: boolean): void {
    const name = message.role === "human" ? "You" : "Assistant";
    if (message.judgment) {
      console.log(`${name}, turn ${index + 1} — provisional score: ${message.judgment.score}/100\n${message.judgment.rationale}\n`);
    } else if (message.judgmentError) {
      console.log(`${name}, turn ${index + 1} — judging failed: ${message.judgmentError}${canRetry ? `\nUse /judge ${index + 1} to retry.` : ""}\n`);
    }
  }
  function printNewSpeeches(current: DebateSession): void {
    const snapshot = current.snapshot;
    const first = printedMessages.get(current) ?? 0;
    if (first >= snapshot.messages.length) return;
    console.log(`\nYou: ${snapshot.humanSide} | Assistant: ${snapshot.assistantSide}\n`);
    for (let index = first; index < snapshot.messages.length; index++) {
      const message = snapshot.messages[index]!;
      const name = message.role === "human" ? "You" : "Assistant";
      console.log(`${name} (turn ${index + 1}):\n${message.text}\n`);
      printJudgment(message, index, snapshot.status !== "ended");
    }
    printedMessages.set(current, snapshot.messages.length);
  }
  let closed = false;
  let active: Promise<void> | null = null;
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const prompt = () => {
    if (closed) return;
    const snapshot = session.snapshot;
    const label = snapshot.pending ? "Use /retry, /new, or /end" :
      snapshot.status === "topic_entry" ? "Topic" :
      snapshot.status === "positions_ready" ? "Choose a side (a/n), /regenerate, or /topic <topic>" :
      snapshot.status === "ended" ? "Use /new or /quit" : "Your argument";
    if (process.stdin.isTTY) { lines.setPrompt(`${label}> `); lines.prompt(); }
  };
  const stop = () => { closed = true; session.end(); printNewSpeeches(session); lines.close(); };
  const onSignal = () => stop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  lines.on("SIGINT", onSignal);
  lines.on("close", () => {
    closed = true;
    session.end();
    printNewSpeeches(session);
    // A piped stdin can keep Node alive even after readline is closed.
    process.stdin.pause();
    if (!process.stdin.isTTY) process.stdin.destroy();
  });

  async function handle(line: string): Promise<void> {
    const input = line.trim();
    if (input === "/quit") { stop(); return; }
    if (input === "/help") { console.log(HELP); prompt(); return; }
    if (input === "/end") { session.end(); printNewSpeeches(session); console.log("Session ended. Use /new to start another."); prompt(); return; }
    if (input === "/new") {
      session.end();
      printNewSpeeches(session);
      // Wait for cancellation before reusing the adapter for another session.
      await active;
      if (closed) return;
      session = new DebateSession(agent, undefined, undefined, judge);
      console.log("Enter a new topic."); prompt(); return;
    }
    if (active) { console.log("Generation is in progress. Use /end or /quit to cancel."); return; }
    if (!input) { console.log("Enter a topic or contribution; empty input is ignored."); prompt(); return; }
    const current = session;
    const before = current.snapshot;
    let operation: () => Promise<void>;
    let judgedIndex: number | null = null;
    if (input === "/retry") operation = () => current.retry();
    else if (input === "/judge" || input.startsWith("/judge ")) {
      const turn = input.slice(6).trim();
      if (!/^[1-9]\d*$/.test(turn) || !Number.isSafeInteger(Number(turn))) {
        console.log("Use /judge <turn> with a positive turn number."); prompt(); return;
      }
      judgedIndex = Number(turn) - 1;
      operation = () => current.judge(judgedIndex!);
    }
    else if (input === "/regenerate") operation = () => current.prepare(before.topic);
    else if (input.startsWith("/topic ")) operation = () => current.prepare(input.slice(7));
    else if (["/affirmative", "/negative"].includes(input) ||
      (before.status === "positions_ready" && ["a", "n", "affirmative", "negative"].includes(input.toLowerCase()))) {
      const side = ["/affirmative", "a", "affirmative"].includes(input.toLowerCase()) ? "affirmative" : "negative";
      operation = () => current.choose(side);
    } else if (input.startsWith("/")) { console.log("Unknown command. Use /help."); prompt(); return; }
    else if (before.status === "topic_entry") operation = () => current.prepare(input);
    else if (before.status === "active") operation = () => current.respond(input);
    else { console.log("Choose a side, use /topic <topic>, or start with /new."); prompt(); return; }

    const work = (async () => {
      try {
        const generation = operation();
        if (current.snapshot.status.startsWith("generating_")) console.log("Generating... (/end or /quit to cancel)");
        await generation;
        if (closed || current.snapshot.status === "ended") return;
        const after = current.snapshot;
        if (after.status === "positions_ready" && after.positions) {
          console.log(`\nMotion: ${after.positions.motion}\nAffirmative: ${after.positions.affirmative}\nNegative: ${after.positions.negative}\n`);
        } else if (after.status === "active") {
          if (judgedIndex === null) printNewSpeeches(current);
          else printJudgment(after.messages[judgedIndex]!, judgedIndex, true);
        }
      } catch (error) { if (!closed) console.error(publicError(error)); }
    })();
    active = work;
    await work;
    if (active === work) active = null;
    prompt();
  }

  console.log(HELP);
  console.log("\nEnter a topic to begin.");
  prompt();
  lines.on("line", line => { void handle(line).catch(() => { console.error("Could not process input."); }); });
  try {
    await new Promise<void>(resolve => lines.once("close", resolve));
    await active;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await Promise.all([agent.dispose(), judge.dispose()]);
  }
}

try { await main(); }
catch (error) { console.error(publicError(error)); process.exitCode = 1; }
