import { randomUUID } from "node:crypto";
import { DebateError } from "./errors.js";
import type { ModelOption } from "./models.js";

export type Side = "affirmative" | "negative";
export interface Positions { motion: string; affirmative: string; negative: string }
export interface Message { role: "human" | "assistant"; text: string }
export interface SpeakerContext {
  recordId: string;
  name: string;
  title: string;
  remarks: { cueId: number; startSeconds: number | null; quote: string; uncertain: boolean; note: string }[];
  totalRemarks: number;
  excerpted: boolean;
  limitations: string[];
}
export interface PracticeContext {
  topic: string;
  positions: Positions;
  humanSide: Side;
  assistantSide: Side;
  messages: Message[];
  speaker?: SpeakerContext;
}
export interface DebateAgent {
  prepare(topic: string, signal: AbortSignal): Promise<Positions>;
  opening(context: PracticeContext, signal: AbortSignal): Promise<string>;
  reply(context: PracticeContext, contribution: string, signal: AbortSignal): Promise<string>;
  resetPractice(): void;
}
export type SessionStatus = "topic_entry" | "generating_positions" | "positions_ready" |
  "generating_opening" | "active" | "generating_response" | "ended";
type Pending = { kind: "positions"; topic: string } | { kind: "opening"; side: Side } |
  { kind: "reply"; contribution: string };
export interface Snapshot {
  id: string;
  status: SessionStatus;
  topic: string;
  positions: Positions | null;
  humanSide: Side | null;
  assistantSide: Side | null;
  messages: Message[];
  pending: Pending | null;
  speaker?: SpeakerContext;
  model?: ModelOption;
}

export function nonempty(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new DebateError(`${label} cannot be empty.`);
  return result;
}

export function parsePositions(raw: string): Positions {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, "$1")); }
  catch { throw new DebateError("The model did not return valid positions. Retry position generation."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DebateError("The model did not return valid positions. Retry position generation.");
  }
  const data = parsed as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !== "affirmative,motion,negative" ||
      [data.motion, data.affirmative, data.negative].some(v => typeof v !== "string" || !v.trim())) {
    throw new DebateError("The model must return one motion and exactly two named positions.");
  }
  const result = { motion: (data.motion as string).trim(), affirmative: (data.affirmative as string).trim(), negative: (data.negative as string).trim() };
  if (/[?？]$/.test(result.affirmative) || /[?？]$/.test(result.negative) ||
      result.affirmative.toLocaleLowerCase() === result.negative.toLocaleLowerCase()) {
    throw new DebateError("The model must return distinct opposing claims, rather than questions.");
  }
  return result;
}

export class DebateSession {
  private state: Snapshot = {
    id: randomUUID(), status: "topic_entry", topic: "", positions: null,
    humanSide: null, assistantSide: null, messages: [], pending: null,
  };
  private controller: AbortController | null = null;
  constructor(private readonly agent: DebateAgent, speaker?: SpeakerContext, model?: ModelOption) {
    if (speaker) this.state.speaker = structuredClone(speaker);
    if (model) this.state.model = structuredClone(model);
  }
  get snapshot(): Snapshot { return structuredClone(this.state); }

  async prepare(topic: string): Promise<void> {
    this.allow("topic_entry", "positions_ready");
    const input = nonempty(topic, "Topic");
    this.state.pending = { kind: "positions", topic: input };
    await this.execute();
  }

  async choose(side: Side): Promise<void> {
    this.allow("positions_ready");
    if (side !== "affirmative" && side !== "negative") throw new DebateError("Choose affirmative or negative.");
    if (this.state.pending) throw new DebateError("Retry the pending generation or start a new session.");
    this.state.humanSide = side;
    this.state.assistantSide = side === "affirmative" ? "negative" : "affirmative";
    this.state.pending = { kind: "opening", side };
    await this.execute();
  }

  async respond(contribution: string): Promise<void> {
    this.allow("active");
    const input = nonempty(contribution, "Contribution");
    if (this.state.pending) throw new DebateError("Retry the pending response or start a new session.");
    this.state.pending = { kind: "reply", contribution: input };
    await this.execute();
  }

  async retry(): Promise<void> {
    this.allow("topic_entry", "positions_ready", "active");
    if (!this.state.pending) throw new DebateError("There is no failed generation to retry.");
    await this.execute();
  }

  end(): void {
    this.state.status = "ended";
    this.state.pending = null;
    this.controller?.abort();
    this.agent.resetPractice();
  }

  private allow(...statuses: SessionStatus[]): void {
    if (!statuses.includes(this.state.status) || this.controller) {
      throw new DebateError("That action is unavailable in the current session state.");
    }
  }

  private context(): PracticeContext {
    const { topic, positions, humanSide, assistantSide, messages } = this.state;
    if (!positions || !humanSide || !assistantSide) throw new DebateError("Choose a side before practicing.");
    return structuredClone({ topic, positions, humanSide, assistantSide, messages,
      ...(this.state.speaker ? { speaker: this.state.speaker } : {}) });
  }

  private async execute(): Promise<void> {
    const pending = this.state.pending!;
    const previous = this.state.status;
    const controller = new AbortController();
    this.controller = controller;
    this.state.status = pending.kind === "positions" ? "generating_positions" :
      pending.kind === "opening" ? "generating_opening" : "generating_response";
    try {
      if (pending.kind === "positions") {
        const positions = await this.agent.prepare(pending.topic, controller.signal);
        if (controller.signal.aborted) return;
        // Validate even adapters used by other interfaces before accepting state.
        this.state.positions = parsePositions(JSON.stringify(positions));
        this.state.topic = pending.topic;
        this.state.humanSide = null;
        this.state.assistantSide = null;
        this.state.messages = [];
        this.agent.resetPractice();
        this.state.status = "positions_ready";
      } else {
        const text = nonempty(await (pending.kind === "opening"
          ? this.agent.opening(this.context(), controller.signal)
          : this.agent.reply(this.context(), pending.contribution, controller.signal)), "Assistant response");
        if (controller.signal.aborted) return;
        if (pending.kind === "reply") this.state.messages.push({ role: "human", text: pending.contribution });
        this.state.messages.push({ role: "assistant", text });
        this.state.status = "active";
      }
      this.state.pending = null;
    } catch (error) {
      this.agent.resetPractice();
      if (controller.signal.aborted) return;
      this.state.status = previous;
      throw error;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
