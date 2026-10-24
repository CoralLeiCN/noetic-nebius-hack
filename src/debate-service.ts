import { DebateSession, type DebateAgent, type Snapshot, type SpeakerContext } from "./debate.js";
import { RecordError } from "./video-record.js";
import type { VideoService } from "./video-service.js";
import type { ModelOption } from "./models.js";
import { PersonaService, type Persona } from "./persona-service.js";

export interface ManagedDebateAgent extends DebateAgent { dispose(): Promise<void> }
type Entry = { session: DebateSession; agent: ManagedDebateAgent; touched: number; running: Promise<void> | null; disposal?: Promise<void> };
export type DebateAction = "prepare" | "choose" | "respond" | "retry" | "end";

/** Practice receives only the saved persona Markdown, never training records. */
export function speakerContext(persona: Persona): SpeakerContext {
  return { personaId: persona.id, name: persona.speakerName, personaMarkdown: persona.markdown };
}

export class DebateService {
  private readonly sessions = new Map<string, Entry>();
  private creating = 0;
  private closed = false;
  private readonly expiry = setInterval(() => { void this.expire().catch(() => {}); }, 60_000).unref();
  private readonly personas: PersonaService;
  constructor(videos: VideoService, private readonly createAgent: (model?: string) => Promise<ManagedDebateAgent>, personas?: PersonaService) {
    this.personas = personas ?? new PersonaService(videos);
  }

  async create(speakerId: string, model?: ModelOption): Promise<Snapshot> {
    if (this.closed) throw new RecordError(503, "The debate service is shutting down.");
    await this.expire();
    for (const [id, entry] of this.sessions) {
      if (entry.session.snapshot.status === "ended") this.sessions.delete(id);
    }
    if (this.sessions.size + this.creating >= 20) throw new RecordError(429, "Too many open debates. End a debate before starting another.");
    this.creating++;
    try {
      const speaker = speakerContext(await this.personas.get(speakerId));
      const agent = await this.createAgent(model?.id);
      if (this.closed) { await agent.dispose(); throw new RecordError(503, "The debate service is shutting down."); }
      const session = new DebateSession(agent, speaker, model);
      this.sessions.set(session.snapshot.id, { session, agent, touched: Date.now(), running: null });
      return session.snapshot;
    } finally { this.creating--; }
  }

  get(id: string): Snapshot { return this.entry(id).session.snapshot; }

  async act(id: string, action: DebateAction, value?: string): Promise<Snapshot> {
    const entry = this.entry(id);
    if (action === "end") {
      entry.session.end();
      await this.dispose(entry);
      return entry.session.snapshot;
    }
    if (entry.running) throw new RecordError(409, "A debate response is already being generated.");
    if (action === "prepare" && (!value?.trim() || value.length > 2000)) throw new RecordError(400, "Enter a topic of 1–2,000 characters.");
    if (action === "respond" && (!value?.trim() || value.length > 12000)) throw new RecordError(400, "Enter an argument of 1–12,000 characters.");
    if (action === "choose" && value !== "affirmative" && value !== "negative") throw new RecordError(400, "Choose affirmative or negative.");
    const snapshot = entry.session.snapshot;
    const allowed = action === "prepare" ? ["topic_entry", "positions_ready"] : action === "choose" ? ["positions_ready"] :
      action === "respond" ? ["active"] : ["topic_entry", "positions_ready", "active"];
    if (!allowed.includes(snapshot.status) || (snapshot.pending && action !== "retry" && action !== "prepare") || (action === "retry" && !snapshot.pending)) {
      throw new RecordError(409, "That action is unavailable. Retry the pending generation or start a new debate.");
    }
    const running = action === "prepare" ? entry.session.prepare(value!) : action === "choose" ? entry.session.choose(value as "affirmative" | "negative") :
      action === "respond" ? entry.session.respond(value!) : entry.session.retry();
    entry.running = running;
    try { await running; return entry.session.snapshot; }
    finally { if (entry.running === running) entry.running = null; entry.touched = Date.now(); }
  }

  private entry(id: string): Entry {
    const entry = this.sessions.get(id);
    if (!entry) throw new RecordError(404, "Debate not found. Start a new debate.");
    entry.touched = Date.now();
    return entry;
  }

  private dispose(entry: Entry): Promise<void> {
    entry.disposal ??= (async () => {
      await entry.running?.catch(() => {});
      await entry.agent.dispose();
    })();
    return entry.disposal;
  }

  private async expire(): Promise<void> {
    for (const [id, entry] of this.sessions) {
      if (Date.now() - entry.touched < 60 * 60_000 || entry.running) continue;
      this.sessions.delete(id);
      entry.session.end();
      await this.dispose(entry);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.expiry);
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    for (const entry of entries) entry.session.end();
    await Promise.all(entries.map(entry => this.dispose(entry)));
  }
}
