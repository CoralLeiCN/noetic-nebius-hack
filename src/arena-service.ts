import { randomUUID } from "node:crypto";
import { type Side, type Positions, type PracticeContext, type SpeakerContext, parsePositions, nonempty } from "./debate.js";
import { speakerContext, type ManagedDebateAgent } from "./debate-service.js";
import type { ArenaModel } from "./arena-providers.js";
import type { ArenaJudge, ArenaJudgment } from "./arena-judge.js";
import { RecordError } from "./video-record.js";
import type { VideoService } from "./video-service.js";
import { PersonaService } from "./persona-service.js";

export type ArenaAction = "prepare" | "run" | "judge" | "retry" | "end";
type Stage = "prepare" | "run" | "judge";
export interface ArenaSnapshot {
  id: string;
  status: "topic_entry" | "generating_positions" | "positions_ready" | "generating_arguments" | "awaiting_judgment" | "judging" | "completed" | "ended";
  topic: string;
  positions: Positions | null;
  speaker: SpeakerContext;
  models: Record<Side | "judge", ArenaModel>;
  messages: { side: Side; text: string }[];
  judgment: ArenaJudgment | null;
  pending: { kind: Stage; topic?: string } | null;
}
interface Entry {
  state: ArenaSnapshot;
  agents: Record<Side, ManagedDebateAgent>;
  judge: ArenaJudge;
  controller: AbortController | null;
  running: Promise<void> | null;
  disposal?: Promise<void>;
  touched: number;
}

/** Arena orchestrates the same preparation/opening/reply adapter used by Practice. */
export class ArenaService {
  private readonly entries = new Map<string, Entry>();
  private creating = 0;
  private closed = false;
  private readonly expiry = setInterval(() => { void this.expire().catch(() => {}); }, 60_000).unref();
  private readonly personas: PersonaService;
  constructor(videos: VideoService,
    private readonly createAgent: (model: ArenaModel) => Promise<ManagedDebateAgent>,
    private readonly createJudge: (model: ArenaModel) => Promise<ArenaJudge>, personas?: PersonaService) {
    this.personas = personas ?? new PersonaService(videos);
  }

  async create(speakerId: string, models: ArenaSnapshot["models"]): Promise<ArenaSnapshot> {
    if (this.closed) throw new RecordError(503, "Arena is shutting down.");
    await this.expire();
    for (const [id, entry] of this.entries) {
      if (entry.state.status !== "ended" && entry.state.status !== "completed") continue;
      this.entries.delete(id);
      await this.dispose(entry);
    }
    if (this.entries.size + this.creating >= 20) throw new RecordError(429, "Too many Arena sessions. End a session before starting another.");
    if (models.affirmative.key === models.negative.key) throw new RecordError(400, "Choose two different models or providers to compare.");
    this.creating++;
    const resources: { dispose(): Promise<void> }[] = [];
    try {
      const speaker = speakerContext(await this.personas.get(speakerId));
      const affirmative = await this.createAgent(models.affirmative); resources.push(affirmative);
      const negative = await this.createAgent(models.negative); resources.push(negative);
      const judge = await this.createJudge(models.judge); resources.push(judge);
      if (this.closed) throw new RecordError(503, "Arena is shutting down.");
      const state: ArenaSnapshot = { id: randomUUID(), status: "topic_entry", topic: "", positions: null,
        speaker, models: structuredClone(models), messages: [], judgment: null, pending: null };
      this.entries.set(state.id, { state, agents: { affirmative, negative }, judge, touched: Date.now(), controller: null, running: null });
      return structuredClone(state);
    } catch (error) {
      await Promise.allSettled(resources.map(resource => resource.dispose()));
      throw error;
    } finally { this.creating--; }
  }

  get(id: string): ArenaSnapshot { return structuredClone(this.entry(id).state); }

  async act(id: string, action: ArenaAction, topic?: string): Promise<ArenaSnapshot> {
    const entry = this.entry(id);
    if (action === "end") {
      entry.state.status = "ended"; entry.state.pending = null;
      entry.controller?.abort();
      await this.dispose(entry);
      return structuredClone(entry.state);
    }
    if (entry.running || entry.state.status === "ended" || entry.state.status === "completed") throw new RecordError(409, "That Arena action is unavailable in the current state.");
    let stage: Stage;
    if (action === "retry") {
      if (!entry.state.pending) throw new RecordError(409, "There is no failed Arena generation to retry.");
      stage = entry.state.pending.kind;
    } else {
      stage = action;
      const allowed = action === "prepare" ? ["topic_entry", "positions_ready"] : action === "run" ? ["positions_ready"] : ["awaiting_judgment"];
      if (!allowed.includes(entry.state.status) || entry.state.pending) throw new RecordError(409, "Retry the pending generation or start a new Arena session.");
      if (action === "prepare" && (!topic?.trim() || topic.length > 2000)) throw new RecordError(400, "Enter a topic of 1–2,000 characters.");
      entry.state.pending = action === "prepare" ? { kind: stage, topic: topic!.trim() } : { kind: stage };
    }
    const running = this.execute(entry, stage);
    entry.running = running;
    try { await running; return structuredClone(entry.state); }
    finally { if (entry.running === running) entry.running = null; entry.touched = Date.now(); }
  }

  private async execute(entry: Entry, stage: Stage): Promise<void> {
    const { state } = entry;
    const previous = state.status;
    const controller = new AbortController(); entry.controller = controller;
    state.status = stage === "prepare" ? "generating_positions" : stage === "run" ? "generating_arguments" : "judging";
    try {
      if (stage === "prepare") {
        const topic = state.pending!.topic!;
        const positions = parsePositions(JSON.stringify(await entry.agents.affirmative.prepare(topic, controller.signal)));
        if (controller.signal.aborted) return;
        state.topic = topic; state.positions = positions; state.messages = []; state.judgment = null;
        for (const agent of Object.values(entry.agents)) agent.resetPractice();
        state.status = "positions_ready";
      } else if (stage === "run") {
        // Both openings, then alternating rebuttals. Only confirmed turns are retained on retry.
        const order: Side[] = ["affirmative", "negative", "affirmative", "negative"];
        while (state.messages.length < order.length) {
          const index = state.messages.length;
          const side = order[index]!;
          const opponent = side === "affirmative" ? "negative" : "affirmative";
          const latest = index >= 2 ? state.messages.at(-1)! : null;
          const history = latest ? state.messages.slice(0, -1) : state.messages;
          const context: PracticeContext = structuredClone({ topic: state.topic, positions: state.positions!,
            assistantSide: side, humanSide: opponent, speaker: state.speaker,
            messages: history.map(message => ({ role: message.side === side ? "assistant" : "human", text: message.text })) });
          const agent = entry.agents[side];
          const text = nonempty(await (latest ? agent.reply(context, latest.text, controller.signal) : agent.opening(context, controller.signal)), "Arena argument");
          if (controller.signal.aborted) return;
          if (text.length > 24_000) throw new RecordError(502, "Arena argument exceeds the evaluation context limit. Retry generation.");
          state.messages.push({ side, text });
        }
        state.status = "awaiting_judgment";
      } else {
        const judgment = await entry.judge.judge(structuredClone({ topic: state.topic, positions: state.positions!,
          speaker: state.speaker, messages: state.messages, models: state.models }), controller.signal);
        if (controller.signal.aborted) return;
        state.judgment = judgment; state.status = "completed";
      }
      state.pending = null;
    } catch (error) {
      if (controller.signal.aborted) return;
      if (stage === "run") for (const agent of Object.values(entry.agents)) agent.resetPractice();
      state.status = previous;
      throw error;
    } finally { if (entry.controller === controller) entry.controller = null; }
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new RecordError(404, "Arena session not found. Start a new comparison.");
    entry.touched = Date.now(); return entry;
  }
  private dispose(entry: Entry): Promise<void> {
    entry.disposal ??= (async () => {
      await entry.running?.catch(() => {});
      await Promise.allSettled([...Object.values(entry.agents), entry.judge].map(resource => resource.dispose()));
    })();
    return entry.disposal;
  }
  private async expire(): Promise<void> {
    for (const [id, entry] of this.entries) {
      if (entry.running || Date.now() - entry.touched < 60 * 60_000) continue;
      this.entries.delete(id); entry.state.status = "ended"; entry.controller?.abort();
      await this.dispose(entry);
    }
  }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.expiry);
    const entries = [...this.entries.values()]; this.entries.clear();
    for (const entry of entries) { entry.state.status = "ended"; entry.controller?.abort(); }
    await Promise.all(entries.map(entry => this.dispose(entry)));
  }
}
