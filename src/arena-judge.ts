import { CodexDebateAgent } from "./codex-agent.js";
import type { ProviderConfig } from "./config.js";
import type { Positions, Side, SpeakerContext } from "./debate.js";
import { DebateError } from "./errors.js";
import { ARENA_CRITERIA, ARENA_JUDGE_INSTRUCTIONS, arenaJudgePrompt } from "./prompts/arena-judge.js";

export { ARENA_CRITERIA } from "./prompts/arena-judge.js";
export interface ArenaJudgeInput {
  topic: string;
  positions: Positions;
  speaker?: SpeakerContext;
  messages: { side: Side; text: string }[];
  models?: unknown;
}
export interface ArenaJudgment {
  scores: { affirmative: number; negative: number };
  rationale: string;
  criteria: string;
  provisional: true;
}
export interface ArenaJudge {
  judge(input: ArenaJudgeInput, signal: AbortSignal): Promise<ArenaJudgment>;
  dispose(): Promise<void>;
}

const schema = {
  type: "object", additionalProperties: false, required: ["scores", "rationale"],
  properties: {
    scores: { type: "object", additionalProperties: false, required: ["affirmative", "negative"],
      properties: { affirmative: { type: "number", minimum: 0, maximum: 100 }, negative: { type: "number", minimum: 0, maximum: 100 } } },
    rationale: { type: "string", minLength: 1, maxLength: 12000 },
  },
};

export function parseArenaJudgment(raw: string): ArenaJudgment {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new DebateError("The judge returned invalid scores. Retry judging."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DebateError("The judge returned invalid scores. Retry judging.");
  const data = value as Record<string, unknown>;
  const scores = data.scores as Record<string, unknown> | undefined;
  if (Object.keys(data).sort().join(",") !== "rationale,scores" || !scores || typeof scores !== "object" || Array.isArray(scores) ||
      Object.keys(scores).sort().join(",") !== "affirmative,negative" ||
      [scores.affirmative, scores.negative].some(score => typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) ||
      typeof data.rationale !== "string" || !data.rationale.trim() || data.rationale.length > 12000) {
    throw new DebateError("The judge must return a score from 0 to 100 for each side and a rationale. Retry judging.");
  }
  return { scores: { affirmative: scores.affirmative as number, negative: scores.negative as number },
    rationale: data.rationale.trim(), criteria: ARENA_CRITERIA, provisional: true };
}

export class CodexArenaJudge implements ArenaJudge {
  private constructor(private readonly agent: CodexDebateAgent) {}
  static async create(config: ProviderConfig): Promise<CodexArenaJudge> {
    return new CodexArenaJudge(await CodexDebateAgent.create(config, ARENA_JUDGE_INSTRUCTIONS));
  }
  async judge(input: ArenaJudgeInput, signal: AbortSignal): Promise<ArenaJudgment> {
    // Hide model identities from the judge to reduce provider preference.
    const { models: _models, ...debate } = input;
    const raw = await this.agent.structured(arenaJudgePrompt(debate), schema, signal);
    return parseArenaJudgment(raw);
  }
  async dispose(): Promise<void> { await this.agent.dispose(); }
}
