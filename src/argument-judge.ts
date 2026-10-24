import { CodexDebateAgent } from "./codex-agent.js";
import type { ProviderConfig } from "./config.js";
import type { Positions, Side } from "./debate.js";
import { DebateError } from "./errors.js";
import { ARGUMENT_CRITERIA, ARGUMENT_JUDGE_INSTRUCTIONS, argumentJudgePrompt } from "./prompts/argument-judge.js";

export { ARGUMENT_CRITERIA } from "./prompts/argument-judge.js";

export interface ArgumentJudgeInput {
  topic: string;
  positions: Positions;
  side: Side;
  text: string;
  /** Only speeches delivered before the speech being assessed. */
  messages: { side: Side; text: string }[];
}

export interface ArgumentJudgment {
  score: number;
  rationale: string;
  breakdown: ArgumentBreakdown;
  criteria: string;
  provisional: true;
}

export interface ArgumentCriterionResult { score: number; comment: string }
export interface ArgumentBreakdown {
  clarity: ArgumentCriterionResult;
  reasoning: ArgumentCriterionResult;
  engagement: ArgumentCriterionResult;
}

export interface ArgumentJudge {
  judge(input: ArgumentJudgeInput, signal: AbortSignal): Promise<ArgumentJudgment>;
  dispose(): Promise<void>;
}

const criterionSchema = {
  type: "object", additionalProperties: false, required: ["score", "comment"],
  properties: {
    score: { type: "number", minimum: 0, maximum: 100 },
    comment: { type: "string", minLength: 1, maxLength: 240 },
  },
};
const schema = {
  type: "object", additionalProperties: false, required: ["rationale", "breakdown"],
  properties: {
    rationale: { type: "string", minLength: 1, maxLength: 180 },
    breakdown: {
      type: "object", additionalProperties: false, required: ["clarity", "reasoning", "engagement"],
      properties: { clarity: criterionSchema, reasoning: criterionSchema, engagement: criterionSchema },
    },
  },
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validComment(value: unknown, limit: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= limit;
}

function parseCriterion(value: unknown): ArgumentCriterionResult {
  if (!object(value) || Object.keys(value).sort().join(",") !== "comment,score" ||
      typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 100 ||
      !validComment(value.comment, 240)) {
    throw new DebateError("The judge must return a score from 0 to 100 and a short comment for every criterion. Retry judging this speech.");
  }
  return { score: value.score, comment: value.comment.trim() };
}

export function parseArgumentJudgment(raw: string): ArgumentJudgment {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new DebateError("The judge returned invalid feedback. Retry judging this speech."); }
  if (!object(value)) {
    throw new DebateError("The judge returned invalid feedback. Retry judging this speech.");
  }
  if (Object.keys(value).sort().join(",") !== "breakdown,rationale" || !validComment(value.rationale, 180) ||
      !object(value.breakdown) || Object.keys(value.breakdown).sort().join(",") !== "clarity,engagement,reasoning") {
    throw new DebateError("The judge must return concise feedback and all three criterion results. Retry judging this speech.");
  }
  const breakdown: ArgumentBreakdown = {
    clarity: parseCriterion(value.breakdown.clarity),
    reasoning: parseCriterion(value.breakdown.reasoning),
    engagement: parseCriterion(value.breakdown.engagement),
  };
  const score = Math.round((breakdown.clarity.score + breakdown.reasoning.score + breakdown.engagement.score) / 3);
  return { score, rationale: value.rationale.trim(), breakdown, criteria: ARGUMENT_CRITERIA, provisional: true };
}

export class CodexArgumentJudge implements ArgumentJudge {
  private constructor(private readonly agent: CodexDebateAgent) {}

  static async create(config: ProviderConfig): Promise<CodexArgumentJudge> {
    return new CodexArgumentJudge(await CodexDebateAgent.create(config, ARGUMENT_JUDGE_INSTRUCTIONS));
  }

  async judge(input: ArgumentJudgeInput, signal: AbortSignal): Promise<ArgumentJudgment> {
    // Copy only debate content; do not reveal human/AI roles, personas, models or previous scores.
    const debate = {
      topic: input.topic,
      positions: { motion: input.positions.motion, affirmative: input.positions.affirmative, negative: input.positions.negative },
      precedingSpeeches: input.messages.map(({ side, text }) => ({ side, text })),
      speech: { side: input.side, text: input.text },
    };
    const raw = await this.agent.structured(argumentJudgePrompt(debate), schema, signal);
    return parseArgumentJudgment(raw);
  }

  async dispose(): Promise<void> { await this.agent.dispose(); }
}
