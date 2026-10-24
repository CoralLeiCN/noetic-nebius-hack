import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_AUDIO_BYTES, type SpeechApi } from "./speech.js";
import { RecordError } from "./video-record.js";

export function speechJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

export async function handleSpeechRequest(request: IncomingMessage, response: ServerResponse, transcribe: boolean, speech: SpeechApi): Promise<void> {
  const limit = transcribe ? MAX_AUDIO_BYTES : 8192;
  const controller = new AbortController();
  const cancel = () => { if (!response.writableEnded) controller.abort(); };
  request.once("aborted", cancel);
  response.once("close", cancel);
  try {
    if (!transcribe && !request.headers["content-type"]?.startsWith("application/json")) throw new RecordError(415, "Send JSON with an input text field.");
    if (Number(request.headers["content-length"]) > limit) throw new RecordError(413, "Speech request exceeds its size limit.");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > limit) throw new RecordError(413, "Speech request exceeds its size limit.");
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    controller.signal.throwIfAborted();
    if (transcribe) return speechJson(response, 200, await speech.transcribe(body, controller.signal));
    let input: unknown;
    try { input = JSON.parse(body.toString("utf8")); } catch { throw new RecordError(400, "Send valid JSON with an input text field."); }
    if (!input || typeof input !== "object" || !("input" in input) || typeof input.input !== "string" || Object.keys(input).some(key => key !== "input" && key !== "voiceId")) throw new RecordError(400, "Send an input text field and an optional voiceId.");
    const voiceId = "voiceId" in input ? input.voiceId : undefined;
    if ("voiceId" in input && (typeof voiceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(voiceId))) throw new RecordError(400, "voiceId must be a valid voice identifier.");
    const audio = await speech.speak(input.input, controller.signal, voiceId as string | undefined);
    response.writeHead(200, { "content-type": "audio/wav", "content-length": audio.length }).end(audio);
  } finally {
    request.off("aborted", cancel);
    response.off("close", cancel);
  }
}
