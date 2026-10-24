import { Ajv } from "ajv";
import { createHash } from "node:crypto";
import schema from "../schema/video-record.schema.json" with { type: "json" };

export interface Cue { id: number; startSeconds: number | null; text: string }
export interface Remark { cueId: number; quote: string; uncertain: boolean; note: string }
export interface Analysis {
  remarks: Remark[];
  summary: { title: string; text: string; remarkIndexes: number[] }[];
  limitations: string[];
}
export interface VideoRecord {
  schemaVersion: "1.0";
  id: string;
  title: string;
  speakerName: string;
  createdAt: string;
  sources: { kind: "url" | "upload"; reference: string }[];
  video: null | { file: string; originalName: string; mimeType: string; bytes: number; sha256: string };
  transcript: { file: "transcript.txt"; sha256: string; provenance: "user-supplied"; audioVerified: false; cues: Cue[] };
  analysis: Analysis;
}

export class RecordError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export const recordSchema = schema;
// Generation can report no match; persisted records require nonempty remarks and summaries.
export const analysisSchema = {
  ...schema.properties.analysis,
  properties: {
    ...schema.properties.analysis.properties,
    remarks: { ...schema.properties.analysis.properties.remarks, minItems: 0 },
    summary: { ...schema.properties.analysis.properties.summary, minItems: 0 },
  },
};
const ajv = new Ajv({ strict: true, allErrors: true });
const checkRecord = ajv.compile<VideoRecord>(recordSchema);
const checkAnalysis = ajv.compile<Analysis>(schema.properties.analysis);
const checkGeneration = ajv.compile<Analysis>(analysisSchema);
export const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const safeId = (id: string): boolean => /^(youtube-|video-)[A-Za-z0-9_-]{1,80}$/.test(id);

export function sourceUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new RecordError(400, "Source URL must be an absolute HTTP or HTTPS link."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || value.length > 2048) {
    throw new RecordError(400, "Source URL must be an HTTP or HTTPS link without embedded credentials.");
  }
  return url.href;
}

/** Parse pasted YouTube cues, plain timestamped text, SRT, VTT, or untimed text. */
export function parseTranscript(text: string): Cue[] {
  if (!text.trim() || text.length > 500_000 || text.includes("\0")) {
    throw new RecordError(400, "Provide a nonempty UTF-8 transcript of at most 500,000 characters, without NUL bytes.");
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const cues: Cue[] = [];
  let active: Cue | undefined;
  let priorTime = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || /^WEBVTT(?:\s|$)/.test(line) || /^Chapter \d+:/.test(line) || line === "Sync to video time") continue;
    if (/^\d+$/.test(line) && lines[i + 1]?.includes("-->")) continue;
    const timed = /^\[?((?:\d{1,3}:)?\d{1,2}:\d{2})(?:[.,]\d{1,3})?\]?(.*)$/.exec(line);
    if (timed) {
      const units = timed[1]!.split(":").map(Number);
      if (units.at(-1)! >= 60 || (units.length === 3 && units[1]! >= 60)) throw new RecordError(400, "Invalid transcript timestamp.");
      const seconds = units.reduce((sum, part) => sum * 60 + part, 0);
      if (seconds < priorTime) throw new RecordError(400, "Transcript timestamps must be chronological.");
      priorTime = seconds;
      let words = timed[2]!;
      words = words.startsWith(" -->") || words.trimStart().startsWith("-->") ? "" : words;
      words = words.replace(/^\d+(?: minutes?(?:, \d+ seconds?)?| seconds?)/, "").trimStart();
      active = { id: cues.length + 1, startSeconds: seconds, text: words };
      cues.push(active);
    } else if (active?.startSeconds !== null && active !== undefined) {
      active.text += (active.text ? "\n" : "") + line;
    } else {
      active = { id: cues.length + 1, startSeconds: null, text: line };
      cues.push(active);
    }
  }
  const populated = cues.filter(cue => cue.text.trim());
  populated.forEach((cue, index) => { cue.id = index + 1; });
  if (!populated.length || populated.length > 10000 || populated.some(cue => cue.text.length > 100000)) {
    throw new RecordError(400, "Transcript needs 1–10,000 nonempty cues, with at most 100,000 characters per cue.");
  }
  return populated;
}

export function validateAnalysis(value: unknown, cues: Cue[]): Analysis {
  if (checkGeneration(value) && value.remarks.length === 0) throw new RecordError(422, "No remarks could be identified for this speaker. Check the speaker name and transcript. Nothing was saved.");
  if (!checkAnalysis(value)) throw new RecordError(502, "Generated remarks did not match the strict analysis schema. Nothing was saved.");
  const byId = new Map(cues.map(cue => [cue.id, cue]));
  let lastCue = 0;
  let offset = 0;
  for (const remark of value.remarks) {
    const cue = byId.get(remark.cueId);
    const start = cue?.text.indexOf(remark.quote, remark.cueId === lastCue ? offset : 0) ?? -1;
    if (!cue || remark.cueId < lastCue || start < 0 || (remark.uncertain && !remark.note.trim())) {
      throw new RecordError(502, "Generated quotes did not match the source cues in order, or lacked an uncertainty note. Nothing was saved.");
    }
    lastCue = remark.cueId;
    offset = start + remark.quote.length;
  }
  if (value.summary.some(section => section.remarkIndexes.some(index => index >= value.remarks.length))) {
    throw new RecordError(502, "Generated summary cited a missing remark. Nothing was saved.");
  }
  return value;
}

export function validateRecord(value: unknown): VideoRecord {
  if (!checkRecord(value)) throw new RecordError(502, "Video record does not match schema version 1.0.");
  const cues = value.transcript.cues;
  let priorTime = -1;
  for (const [index, cue] of cues.entries()) {
    if (cue.id !== index + 1 || (cue.startSeconds !== null && cue.startSeconds < priorTime)) {
      throw new RecordError(502, "Video record contains invalid cue IDs or timestamps.");
    }
    if (cue.startSeconds !== null) priorTime = cue.startSeconds;
  }
  for (const source of value.sources) {
    if (source.kind === "url") sourceUrl(source.reference);
    else if (!value.video || source.reference !== value.video.file) throw new RecordError(502, "Video record contains an invalid upload reference.");
  }
  if (value.video && !value.sources.some(source => source.kind === "upload" && source.reference === value.video!.file)) {
    throw new RecordError(502, "Video upload is missing its source reference.");
  }
  validateAnalysis(value.analysis, cues);
  return value;
}

export function timestamp(seconds: number | null): string {
  if (seconds === null) return "Untimed";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const md = (value: string): string => value.replace(/[\\`*_{}\[\]<>#|]/g, "\\$&");
export function renderRecord(record: VideoRecord): Record<string, string> {
  const sourceLines = record.sources.map(source => source.kind === "url"
    ? `- [Source video](<${source.reference.replace(/[<>\s]/g, char => encodeURIComponent(char))}>)`
    : `- [Uploaded video](${source.reference})`).join("\n");
  const header = `# ${md(record.title)}\n\nSpeaker: ${md(record.speakerName)}\n\n${sourceLines}\n\n`;
  const remarks = record.analysis.remarks.map(remark => {
    const cue = record.transcript.cues[remark.cueId - 1]!;
    return `**${timestamp(cue.startSeconds)}** ${md(remark.quote)}${remark.note ? `\n\n*${md(remark.note)}*` : ""}`;
  }).join("\n\n");
  const summary = record.analysis.summary.map(section => {
    const references = section.remarkIndexes.map(index => {
      const remark = record.analysis.remarks[index]!;
      return `${index + 1} (${timestamp(record.transcript.cues[remark.cueId - 1]!.startSeconds)})`;
    }).join(", ");
    return `## ${md(section.title)}\n\n${md(section.text)}\n\nSupporting remarks: ${references}.`;
  }).join("\n\n");
  const limits = "\n\n## Limitations\n\n- Derived from supplied captions; not verified against audio.\n" +
    record.analysis.limitations.map(note => `- ${md(note)}`).join("\n") + "\n";
  return {
    "README.md": header + "## Records\n\n- [Structured record](record.json)\n- [Full supplied transcript](transcript.txt)\n- [Speaker remarks](speaker-remarks.md)\n- [Summarized remarks](summary.md)\n\nSchema version: 1.0. The transcript is preserved as supplied. Quotes are checked against source cues; speaker attribution and summaries are generated and should be reviewed.\n",
    "speaker-remarks.md": header + remarks + limits,
    "summary.md": header + summary + limits,
  };
}
