import { execFile } from "node:child_process";
import { RecordError } from "./video-record.js";

export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const MAX_SPEECH_CHARACTERS = 600;
export const MAX_AUDIO_SECONDS = 120;
const SAMPLE_RATE = 16_000;
const TIMEOUT_MS = 120_000;
// Published in ElevenLabs' Politician Voice Library (The Rising Reformer).
export const RISING_REFORMER_VOICE_ID = "6osMNatXqZrKCuGTB2bV";

export interface SpeechVoiceCatalog {
  provider: "local" | "elevenlabs";
  defaultVoiceId: string;
  voices: { id: string; name: string }[];
  speakerDefaults: Record<string, string>;
}

export interface SpeechConfig {
  ttsProvider: "local" | "elevenlabs";
  elevenLabs?: { apiKey: string; voiceId: string; modelId: string };
  asrUrl: string;
  asrModel: string;
  asrLanguage: string;
  ttsUrl: string;
  ttsModel: string;
  voice: string;
}

export interface SpeechApi {
  transcribe(audio: Uint8Array, signal?: AbortSignal): Promise<{ text: string; model: string }>;
  speak(text: string, signal?: AbortSignal, voiceId?: string): Promise<Buffer>;
  voices?(): Promise<SpeechVoiceCatalog>;
}

export function speechOrigin(raw: string, name: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new RecordError(400, `${name} must be a loopback HTTP URL.`); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new RecordError(400, `${name} must be a loopback HTTP URL without a path or credentials.`);
  }
  return url.origin;
}

export function loadSpeechConfig(env: NodeJS.ProcessEnv = process.env): SpeechConfig {
  function localUrl(name: string, fallback: string): string {
    return speechOrigin(env[name] ?? fallback, name);
  }
  const asrLanguage = env.LOCAL_ASR_LANGUAGE?.trim() || "en";
  if (asrLanguage.length > 35 || !/^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(asrLanguage)) {
    throw new RecordError(400, "LOCAL_ASR_LANGUAGE must be a language code such as en or en-GB, or auto.");
  }
  const ttsProvider = env.TTS_PROVIDER?.trim() || "local";
  if (ttsProvider !== "local" && ttsProvider !== "elevenlabs") throw new RecordError(400, "TTS_PROVIDER must be local or elevenlabs.");
  let elevenLabs: SpeechConfig["elevenLabs"];
  if (ttsProvider === "elevenlabs") {
    const apiKey = env.ELEVENLABS_API_KEY?.trim();
    const voiceId = env.ELEVENLABS_VOICE_ID?.trim() || "JBFqnCBsd6RMkjVDRZzb";
    if (!apiKey) throw new RecordError(400, "Set ELEVENLABS_API_KEY when TTS_PROVIDER=elevenlabs.");
    elevenLabs = { apiKey, voiceId, modelId: env.ELEVENLABS_MODEL_ID?.trim() || "eleven_multilingual_v2" };
  }
  return {
    ttsProvider,
    ...(elevenLabs ? { elevenLabs } : {}),
    asrUrl: localUrl("LOCAL_ASR_URL", "http://127.0.0.1:8765"),
    asrModel: env.LOCAL_ASR_MODEL?.trim() || "mlx-community/nemotron-3.5-asr-streaming-0.6b-8bit",
    asrLanguage,
    ttsUrl: localUrl("LOCAL_TTS_URL", "http://127.0.0.1:8766"),
    ttsModel: env.LOCAL_TTS_MODEL?.trim() || "mlx-community/Voxtral-4B-TTS-2603-mlx-4bit",
    voice: env.LOCAL_TTS_VOICE?.trim() || "neutral_female",
  };
}

export async function normalizeAudio(audio: Uint8Array, signal: AbortSignal): Promise<Buffer> {
  if (!audio.length || audio.length > MAX_AUDIO_BYTES) throw new RecordError(413, "Provide audio of at most 16 MiB and 120 seconds.");
  const pcm = await new Promise<Buffer>((resolve, reject) => {
    const child = execFile("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "pipe", "-i", "pipe:0", "-t", String(MAX_AUDIO_SECONDS + 1), "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "pipe:1"],
      { encoding: "buffer", maxBuffer: (MAX_AUDIO_SECONDS + 2) * SAMPLE_RATE * 2, timeout: 30_000, signal },
      (error, stdout) => {
        if (signal.aborted) reject(signal.reason);
        else if (error) reject(new RecordError(422, "Could not decode audio. Install ffmpeg and use a supported audio file."));
        else resolve(stdout);
      });
    child.stdin?.on("error", () => { /* Process exit is handled by execFile. */ });
    child.stdin?.end(audio);
  });
  if (!pcm.length || pcm.length > MAX_AUDIO_SECONDS * SAMPLE_RATE * 2) throw new RecordError(413, "Audio must be nonempty and at most 120 seconds. Split longer recordings into shorter clips.");
  return pcmToWav(pcm, SAMPLE_RATE);
}

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  if (!response.body) throw new RecordError(502, "The speech provider returned an empty response.");
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new RecordError(502, "The speech response exceeded its size limit.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class Speech implements SpeechApi {
  private busy = false;
  constructor(readonly config: SpeechConfig = loadSpeechConfig(), private readonly request: typeof fetch = fetch) {}

  async voices(): Promise<SpeechVoiceCatalog> {
    if (this.config.ttsProvider === "local") {
      return { provider: "local", defaultVoiceId: this.config.voice, voices: [{ id: this.config.voice, name: "Local voice" }], speakerDefaults: {} };
    }
    const defaultVoiceId = this.config.elevenLabs?.voiceId ?? "JBFqnCBsd6RMkjVDRZzb";
    return {
      provider: "elevenlabs", defaultVoiceId,
      voices: [
        ...(defaultVoiceId === RISING_REFORMER_VOICE_ID ? [] : [{ id: defaultVoiceId, name: "Default voice" }]),
        { id: RISING_REFORMER_VOICE_ID, name: "The Rising Reformer" },
      ],
      speakerDefaults: { "andy burnham": RISING_REFORMER_VOICE_ID },
    };
  }

  private async run<T>(task: "transcription" | "synthesis", operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.busy) throw new RecordError(429, "Speech is busy. Wait for the current request to finish.");
    this.busy = true;
    const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
    try {
      boundedSignal.throwIfAborted();
      return await operation(boundedSignal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof RecordError) throw error;
      if (boundedSignal.aborted) throw new RecordError(503, "Speech timed out. Try a shorter clip or passage.");
      const message = task === "transcription"
        ? "Local transcription is unavailable. Run npm run speech:setup once, then npm run speech:start to start the transcription worker. ElevenLabs is used for voice playback only."
        : this.config.ttsProvider === "elevenlabs"
          ? "ElevenLabs speech is unavailable. Check your internet connection and try playback again."
          : "Local speech is unavailable. Run npm run speech:start and check the local voice model configuration.";
      throw new RecordError(503, message);
    } finally { this.busy = false; }
  }

  async transcribe(audio: Uint8Array, signal?: AbortSignal): Promise<{ text: string; model: string }> {
    return this.run("transcription", async boundedSignal => {
      const wav = await normalizeAudio(audio, boundedSignal);
      const form = new FormData();
      form.set("model", this.config.asrModel);
      form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
      form.set("response_format", "json");
      // Nemotron's auto prompt can return an empty transcript for short English
      // utterances. Use the configured language unless automatic detection is requested.
      if (this.config.asrLanguage !== "auto") form.set("language", this.config.asrLanguage);
      const response = await this.request(`${this.config.asrUrl}/v1/audio/transcriptions`, { method: "POST", body: form, redirect: "error", signal: boundedSignal });
      if (!response.ok) throw new RecordError(response.status === 429 ? 429 : 502, "The local transcription server rejected the request. Check the loaded model and audio.");
      const body = await boundedBody(response, 1024 * 1024);
      let result: unknown;
      try { result = JSON.parse(body.toString("utf8")); }
      catch { throw new RecordError(502, "The local transcription server returned an invalid transcript."); }
      if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string") throw new RecordError(502, "The local transcription server returned an invalid transcript.");
      return { text: result.text, model: this.config.asrModel };
    }, signal);
  }

  async speak(text: string, signal?: AbortSignal, voiceId?: string): Promise<Buffer> {
    if (!text.trim() || text.length > MAX_SPEECH_CHARACTERS) throw new RecordError(400, "Provide between 1 and 600 characters for speech. Split longer passages into shorter excerpts.");
    const catalog = await this.voices();
    const selectedVoiceId = voiceId ?? catalog.defaultVoiceId;
    if (!catalog.voices.some(voice => voice.id === selectedVoiceId)) throw new RecordError(400, "Choose a voice available from the current speech provider.");
    return this.run("synthesis", async boundedSignal => {
      if (this.config.ttsProvider === "elevenlabs") return this.speakElevenLabs(text, boundedSignal, selectedVoiceId);
      const response = await this.request(`${this.config.ttsUrl}/v1/audio/speech`, {
        method: "POST", redirect: "error", signal: boundedSignal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.config.ttsModel, input: text, voice: selectedVoiceId, response_format: "wav", max_new_tokens: 750 }),
      });
      if (!response.ok) throw new RecordError(response.status === 429 ? 429 : 502, "The local speech server rejected the request. Check the loaded model and voice.");
      if (response.headers.get("x-finish-reason") !== "stop") {
        await response.body?.cancel();
        throw new RecordError(502, "Speech did not finish completely. Try a shorter passage.");
      }
      const wav = await boundedBody(response, 8 * 1024 * 1024);
      if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new RecordError(502, "The local speech server returned invalid audio.");
      return wav;
    }, signal);
  }

  private async speakElevenLabs(text: string, signal: AbortSignal, voiceId: string): Promise<Buffer> {
    const config = this.config.elevenLabs;
    if (!config) throw new RecordError(400, "Configure ELEVENLABS_API_KEY for ElevenLabs speech.");
    const response = await this.request(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_24000`, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", "xi-api-key": config.apiKey },
      body: JSON.stringify({ text, model_id: config.modelId }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) throw new RecordError(502, "This ElevenLabs voice is not available to your account. Add it to My Voices in ElevenLabs, then try again, or choose Default voice.");
      throw new RecordError(response.status === 429 ? 429 : 502, "ElevenLabs rejected the speech request. Check the API key, voice, model and account quota.");
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType && contentType !== "application/octet-stream" && contentType !== "audio/pcm" && contentType !== "audio/raw") {
      await response.body?.cancel();
      throw new RecordError(502, "ElevenLabs returned invalid audio; expected PCM.");
    }
    const pcm = await boundedBody(response, 8 * 1024 * 1024 - 44);
    if (!pcm.length || pcm.length % 2 !== 0) throw new RecordError(502, "ElevenLabs returned invalid PCM audio.");
    return pcmToWav(pcm, 24_000);
  }
}

export class SpeechServiceClient implements SpeechApi {
  readonly origin: string;
  constructor(origin = process.env.SPEECH_SERVICE_URL ?? "http://127.0.0.1:8764") {
    this.origin = speechOrigin(origin, "SPEECH_SERVICE_URL");
  }

  private async request(path: string, body: Uint8Array | string | undefined, type: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
    const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS + 5000)]) : AbortSignal.timeout(TIMEOUT_MS + 5000);
    try {
      const response = await fetch(`${this.origin}${path}`, { ...(body === undefined ? { method: "GET" } : { method: "POST", body: typeof body === "string" ? body : new Uint8Array(body), headers: { "content-type": type } }), redirect: "error", signal: boundedSignal });
      if (!response.ok) {
        const result: unknown = JSON.parse((await boundedBody(response, 8192)).toString("utf8"));
        const message = result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : "The speech service rejected the request.";
        throw new RecordError(response.status, message);
      }
      return await boundedBody(response, limit);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof RecordError) throw error;
      throw new RecordError(503, "The speech microservice is unavailable. Restart npm run start:web, or run npm run speech:start separately.");
    }
  }

  async transcribe(audio: Uint8Array, signal?: AbortSignal): Promise<{ text: string; model: string }> {
    if (!audio.length || audio.length > MAX_AUDIO_BYTES) throw new RecordError(413, "Provide audio of at most 16 MiB and 120 seconds.");
    const result: unknown = JSON.parse((await this.request("/api/speech/transcriptions", audio, "application/octet-stream", 1024 * 1024, signal)).toString("utf8"));
    if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string" || !("model" in result) || typeof result.model !== "string") throw new RecordError(502, "The speech microservice returned an invalid transcript.");
    return { text: result.text, model: result.model };
  }

  async voices(): Promise<SpeechVoiceCatalog> {
    const result: unknown = JSON.parse((await this.request("/api/speech/voices", undefined, "application/json", 64 * 1024)).toString("utf8"));
    if (!result || typeof result !== "object" || !("provider" in result) || !["local", "elevenlabs"].includes(String(result.provider)) ||
      !("defaultVoiceId" in result) || typeof result.defaultVoiceId !== "string" || !("voices" in result) || !Array.isArray(result.voices) ||
      !result.voices.every(voice => voice && typeof voice.id === "string" && typeof voice.name === "string") ||
      !("speakerDefaults" in result) || !result.speakerDefaults || typeof result.speakerDefaults !== "object" || Array.isArray(result.speakerDefaults) ||
      !Object.values(result.speakerDefaults).every(id => typeof id === "string")) throw new RecordError(502, "The speech microservice returned an invalid voice catalog.");
    return result as SpeechVoiceCatalog;
  }

  async speak(text: string, signal?: AbortSignal, voiceId?: string): Promise<Buffer> {
    return this.request("/api/speech/audio", JSON.stringify({ input: text, ...(voiceId === undefined ? {} : { voiceId }) }), "application/json", 8 * 1024 * 1024, signal);
  }
}
