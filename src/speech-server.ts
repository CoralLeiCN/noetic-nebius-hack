import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Speech, MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS, MAX_SPEECH_CHARACTERS } from "./speech.js";
import { handleSpeechRequest, speechJson } from "./speech-http.js";
import { RecordError } from "./video-record.js";

export function speechAllowedOrigins(raw = process.env.SPEECH_ALLOWED_ORIGINS ?? "http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:3011,http://localhost:3011"): Set<string> {
  return new Set(raw.split(",").map(value => value.trim()).filter(Boolean).map(value => {
    let url: URL;
    try { url = new URL(value); } catch { throw new RecordError(400, "SPEECH_ALLOWED_ORIGINS must contain exact HTTP or HTTPS origins."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new RecordError(400, "SPEECH_ALLOWED_ORIGINS must contain exact HTTP or HTTPS origins.");
    return url.origin;
  }));
}

export function createSpeechServer(speech = new Speech(), allowedOrigins = speechAllowedOrigins()) {
  const server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", "no-store");
    response.setHeader("vary", "Origin");
    try {
      const host = request.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) throw new RecordError(403, "Use the local speech service address.");
      const url = new URL(request.url ?? "/", `http://${host}`);
      const origin = request.headers.origin;
      if (origin && origin !== url.origin && !allowedOrigins.has(origin)) throw new RecordError(403, "This frontend origin is not allowed.");
      if (origin) response.setHeader("access-control-allow-origin", origin);
      const speechRoute = ["/api/speech/transcriptions", "/api/speech/audio"].includes(url.pathname);
      if (request.method === "OPTIONS" && (speechRoute || url.pathname === "/health" || url.pathname === "/api/speech/voices")) {
        const method = request.headers["access-control-request-method"];
        const headers = (request.headers["access-control-request-headers"] ?? "").toLowerCase().split(",").map(value => value.trim()).filter(Boolean);
        if (method !== (speechRoute ? "POST" : "GET") || headers.some(header => header !== "content-type")) throw new RecordError(403, "Unsupported speech preflight request.");
        response.writeHead(204, { "access-control-allow-methods": speechRoute ? "POST" : "GET", "access-control-allow-headers": "Content-Type", "access-control-max-age": "600" }).end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/speech/voices") return speechJson(response, 200, await speech.voices());
      if (request.method === "GET" && url.pathname === "/health") {
        const models = await Promise.all(([
          ["asr", speech.config.asrUrl, speech.config.asrModel],
          ["tts", speech.config.ttsUrl, speech.config.ttsModel],
        ] as const).map(async ([task, origin, model]) => {
          if (task === "tts" && speech.config.ttsProvider === "elevenlabs") {
            // Configuration readiness only: health checks never synthesize billable speech.
            const configured = Boolean(speech.config.elevenLabs?.apiKey && speech.config.elevenLabs?.voiceId);
            return { task, provider: "elevenlabs", model: speech.config.elevenLabs?.modelId, ready: configured, configured, verified: false };
          }
          let ready = false;
          try {
            const response = await fetch(`${origin}/v1/models`, { redirect: "error", signal: AbortSignal.timeout(1500) });
            const result: unknown = response.ok ? await response.json() : null;
            ready = Boolean(result && typeof result === "object" && "data" in result && Array.isArray(result.data) && result.data.some(entry => entry && typeof entry === "object" && "id" in entry && entry.id === model));
          } catch { /* A starting or unavailable worker is not ready. */ }
          return { task, model, ready };
        }));
        const ready = models.every(model => model.ready);
        return speechJson(response, ready ? 200 : 503, { ready, models, limits: { audioBytes: MAX_AUDIO_BYTES, audioSeconds: MAX_AUDIO_SECONDS, textCharacters: MAX_SPEECH_CHARACTERS, concurrentRequests: 1 } });
      }
      if (request.method === "POST" && speechRoute) return await handleSpeechRequest(request, response, url.pathname.endsWith("/transcriptions"), speech);
      throw new RecordError(404, "Not found.");
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      speechJson(response, error instanceof RecordError ? error.status : 502, { error: error instanceof RecordError ? error.message : "Speech request failed." });
    }
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 30_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const port = Number(process.env.SPEECH_PORT ?? 8764);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RecordError(400, "SPEECH_PORT must be between 1 and 65535.");
    const server = createSpeechServer();
    server.on("error", () => { console.error("Could not start the speech microservice. Check SPEECH_PORT and model configuration."); process.exitCode = 1; });
    server.listen(port, "127.0.0.1", () => console.log(`Speech microservice: http://127.0.0.1:${port}`));
    for (const event of ["SIGINT", "SIGTERM"] as const) process.once(event, () => { server.close(); server.closeAllConnections(); });
  } catch (error) { console.error(error instanceof RecordError ? error.message : "Could not configure the speech microservice."); process.exitCode = 1; }
}
