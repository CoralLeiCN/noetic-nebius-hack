import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv } from "ajv";
import { CodexDebateAgent } from "./codex-agent.js";
import { digest, RecordError, type VideoRecord } from "./video-record.js";
import type { VideoService } from "./video-service.js";
import { PERSONA_GENERATION_PROMPT, buildPersonaGenerationPrompt } from "./prompts/persona-generation.js";
import { buildPersonaPracticePrompt } from "./prompts/persona-practice.js";

export const DIMENSIONS = [
  "Language and vocabulary", "Sentence structure and rhythm", "Tone and register",
  "Rhetorical devices", "Argument structure", "Use of evidence and examples",
  "Interaction and rebuttal", "Uncertainty and expressed values",
] as const;
type Dimension = typeof DIMENSIONS[number];
interface Evidence { recordId: string; cueId: number; quote: string }
export interface PersonaAnalysis {
  dimensions: { dimension: Dimension; observation: string; guidance: string;
    confidence: "high" | "medium" | "low" | "unknown"; evidence: Evidence[] }[];
  limitations: string[];
}
export interface Persona {
  schemaVersion: "1.0" | "1.1";
  kind?: "authored";
  id: string;
  speakerName: string;
  createdAt: string;
  sourceCount: number;
  sourceIds: string[];
  sources: { id: string; title: string; sha256: string }[];
  analysis: PersonaAnalysis;
  markdown: string;
  markdownSha256: string;
}
export type PersonaSummary = Pick<Persona, "id" | "speakerName" | "createdAt" | "sourceCount" | "kind">;
export interface PersonaAnalyzer {
  analyze(speakerName: string, records: VideoRecord[], signal: AbortSignal): Promise<unknown>;
}

const text = { type: "string", minLength: 1, maxLength: 2000 };
export const personaAnalysisSchema = {
  type: "object", additionalProperties: false, required: ["dimensions", "limitations"],
  properties: {
    dimensions: { type: "array", minItems: DIMENSIONS.length, maxItems: DIMENSIONS.length, items: {
      type: "object", additionalProperties: false,
      required: ["dimension", "observation", "guidance", "confidence", "evidence"],
      properties: {
        dimension: { type: "string", enum: [...DIMENSIONS] }, observation: text, guidance: text,
        confidence: { type: "string", enum: ["high", "medium", "low", "unknown"] },
        evidence: { type: "array", maxItems: 6, items: {
          type: "object", additionalProperties: false, required: ["recordId", "cueId", "quote"],
          properties: { recordId: text, cueId: { type: "integer", minimum: 1 },
            quote: { type: "string", minLength: 1, maxLength: 500 } },
        } },
      },
    } },
    limitations: { type: "array", minItems: 1, maxItems: 30, items: text },
  },
};
const validate = new Ajv({ strict: true }).compile<PersonaAnalysis>(personaAnalysisSchema);
const manifestSchema = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "id", "speakerName", "createdAt", "sourceCount", "sourceIds", "sources", "analysis", "markdownSha256"],
  properties: {
    schemaVersion: { const: "1.0" }, id: { type: "string", pattern: "^persona-[a-f0-9-]{36}$" },
    speakerName: { type: "string", minLength: 1, maxLength: 120 }, createdAt: { type: "string" },
    sourceCount: { type: "integer", minimum: 1 },
    sourceIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: "^(youtube-|video-)[A-Za-z0-9_-]{1,80}$" } },
    sources: { type: "array", minItems: 1, items: {
      type: "object", additionalProperties: false, required: ["id", "title", "sha256"],
      properties: { id: { type: "string" }, title: { type: "string" }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" } },
    } },
    analysis: personaAnalysisSchema, markdownSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
};
// Authored personas carry instructions supplied by an author, rather than
// observations compiled from video records. Keep their provenance separate.
const authoredManifestSchema = {
  ...manifestSchema,
  required: [...manifestSchema.required, "kind"],
  properties: {
    ...manifestSchema.properties,
    schemaVersion: { const: "1.1" }, kind: { const: "authored" },
    sourceCount: { const: 0 },
    sourceIds: { type: "array", maxItems: 0 },
    sources: { type: "array", maxItems: 0 },
    analysis: {
      ...personaAnalysisSchema,
      properties: {
        ...personaAnalysisSchema.properties,
        dimensions: { type: "array", maxItems: 0 },
      },
    },
  },
};
const validateManifest = new Ajv({ strict: true }).compile<Omit<Persona, "markdown">>({
  anyOf: [manifestSchema, authoredManifestSchema],
});
export const speakerKey = (name: string): string => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const personaId = (id: string): boolean => /^persona-[a-f0-9-]{36}$/.test(id);
const hashText = (value: string): string => digest(Buffer.from(value, "utf8"));

function trainingData(speakerName: string, records: VideoRecord[]): string {
  return JSON.stringify({ speakerName, dimensions: DIMENSIONS, records: records.map(record => ({
    recordId: record.id, title: record.title, remarks: record.analysis.remarks,
    limitations: record.analysis.limitations, audioVerified: false,
  })) });
}

export class CodexPersonaAnalyzer implements PersonaAnalyzer {
  async analyze(speakerName: string, records: VideoRecord[], signal: AbortSignal): Promise<unknown> {
    const agent = await CodexDebateAgent.createOAuth(PERSONA_GENERATION_PROMPT);
    try {
      const output = await agent.structured(buildPersonaGenerationPrompt(trainingData(speakerName, records)), personaAnalysisSchema, signal);
      try { return JSON.parse(output); }
      catch { throw new RecordError(502, "Persona analysis returned invalid JSON. No persona was saved."); }
    } finally { await agent.dispose(); }
  }
}

export function validatePersonaAnalysis(value: unknown, records: VideoRecord[]): PersonaAnalysis {
  if (!validate(value) || new Set(value.dimensions.map(item => item.dimension)).size !== DIMENSIONS.length) {
    throw new RecordError(502, "Persona analysis did not match the required dimensions. No persona was saved.");
  }
  for (const dimension of value.dimensions) {
    if ((dimension.confidence === "unknown") !== (dimension.evidence.length === 0)) {
      throw new RecordError(502, "Persona confidence must match its supporting evidence. No persona was saved.");
    }
    for (const evidence of dimension.evidence) {
      const record = records.find(record => record.id === evidence.recordId);
      const matches = record?.analysis.remarks.filter(remark => remark.cueId === evidence.cueId && remark.quote.includes(evidence.quote));
      if (!matches?.length) {
        throw new RecordError(502, "Persona evidence does not match the saved speaker remarks. No persona was saved.");
      }
      if (matches.every(remark => remark.uncertain) && dimension.confidence !== "low") {
        throw new RecordError(502, "Uncertain speaker attribution requires low persona confidence. No persona was saved.");
      }
    }
  }
  if (value.dimensions.every(dimension => dimension.confidence === "unknown")) {
    throw new RecordError(422, "The sources do not support a speaker persona. Add more speaker material.");
  }
  return value;
}

export function renderPersona(persona: Pick<Persona, "speakerName" | "analysis">): string {
  return buildPersonaPracticePrompt(persona, DIMENSIONS);
}

export class PersonaService {
  private processing = false;
  constructor(private readonly videos: VideoService, private readonly analyzer: PersonaAnalyzer = new CodexPersonaAnalyzer()) {}

  async create(speakerName: string, signal: AbortSignal): Promise<Persona> {
    if (this.processing) throw new RecordError(429, "A persona is already being compiled. Wait for it to finish.");
    if (!speakerName.trim() || speakerName.length > 120) throw new RecordError(400, "Provide a speaker name of at most 120 characters.");
    this.processing = true;
    try {
      const records = [];
      for (const source of await this.videos.list()) {
        if (speakerKey(source.speakerName) === speakerKey(speakerName)) records.push(await this.videos.get(source.id));
      }
      if (!records.length) throw new RecordError(404, "No saved sources found for this speaker. Add a source first.");
      if (trainingData(speakerName, records).length > 120_000) {
        throw new RecordError(413, "The speaker's source material exceeds the 120,000-character persona analysis limit. Use smaller source records.");
      }
      signal.throwIfAborted();
      const analysis = validatePersonaAnalysis(await this.analyzer.analyze(records[0]!.speakerName, records, signal), records);
      signal.throwIfAborted();
      const metadata = {
        schemaVersion: "1.0" as const, id: `persona-${randomUUID()}`, speakerName: records[0]!.speakerName,
        createdAt: new Date().toISOString(), sourceCount: records.length, sourceIds: records.map(record => record.id),
        sources: records.map(record => ({ id: record.id, title: record.title, sha256: hashText(JSON.stringify(record)) })), analysis,
      };
      const markdown = renderPersona(metadata);
      if (markdown.length > 48_000) throw new RecordError(502, "Compiled persona is too long. No persona was saved.");
      const persona: Persona = { ...metadata, markdown, markdownSha256: hashText(markdown) };
      const pending = join(this.videos.dataDirectory, `.pending-persona-${randomUUID()}`);
      await mkdir(pending, { mode: 0o700 });
      try {
        await writeFile(join(pending, "persona.md"), markdown, { mode: 0o600 });
        const { markdown: _markdown, ...manifest } = persona;
        await writeFile(join(pending, "persona.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
        signal.throwIfAborted();
        await rename(pending, join(this.videos.dataDirectory, persona.id));
      } finally { await rm(pending, { recursive: true, force: true }); }
      return persona;
    } finally { this.processing = false; }
  }

  async get(id: string): Promise<Persona> {
    if (!personaId(id)) throw new RecordError(404, "Speaker persona not found. Compile a persona in the source library first.");
    const folder = join(this.videos.dataDirectory, id);
    try {
      if (!(await lstat(folder)).isDirectory()) throw new RecordError(404, "Speaker persona not found.");
      for (const name of ["persona.json", "persona.md"]) {
        if (!(await lstat(join(folder, name))).isFile()) throw new RecordError(500, "Saved persona files are invalid.");
      }
      const manifest: unknown = JSON.parse(await readFile(join(folder, "persona.json"), "utf8"));
      const markdown = await readFile(join(folder, "persona.md"), "utf8");
      if (!validateManifest(manifest) || manifest.id !== id || !manifest.speakerName.trim() ||
          !Number.isFinite(Date.parse(manifest.createdAt)) || manifest.sourceCount !== manifest.sourceIds.length ||
          manifest.sources.length !== manifest.sourceCount ||
          manifest.sources.some((source, index) => source.id !== manifest.sourceIds[index]) ||
          new Set(manifest.analysis.dimensions.map(item => item.dimension)).size !== (manifest.kind === "authored" ? 0 : DIMENSIONS.length) ||
          manifest.analysis.dimensions.some(item => (item.confidence === "unknown") !== (item.evidence.length === 0) ||
            item.evidence.some(evidence => !manifest.sourceIds.includes(evidence.recordId))) ||
          !markdown.trim() || markdown.length > 48_000 || hashText(markdown) !== manifest.markdownSha256) {
        throw new RecordError(500, "Saved persona does not match its manifest.");
      }
      return { ...manifest, markdown };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RecordError(404, "Speaker persona not found. Compile a persona in the source library first.");
      if (error instanceof SyntaxError) throw new RecordError(500, "Saved persona manifest is invalid.");
      throw error;
    }
  }

  async list(): Promise<PersonaSummary[]> {
    await mkdir(this.videos.dataDirectory, { recursive: true });
    const personas: Persona[] = [];
    for (const entry of await readdir(this.videos.dataDirectory, { withFileTypes: true })) {
      if (entry.isDirectory() && personaId(entry.name)) personas.push(await this.get(entry.name));
    }
    personas.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const names = new Set<string>();
    return personas.filter(persona => {
      const key = speakerKey(persona.speakerName);
      if (names.has(key)) return false;
      names.add(key); return true;
    }).map(({ id, speakerName, createdAt, sourceCount, kind }) => ({ id, speakerName, createdAt, sourceCount, ...(kind ? { kind } : {}) }));
  }
}
