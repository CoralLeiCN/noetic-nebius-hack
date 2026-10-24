import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { publicError } from "./errors.js";
import { recordSchema, RecordError } from "./video-record.js";
import { CodexVideoAnalyzer, VideoService, type CreateVideo } from "./video-service.js";

const MAX_BODY = 102 * 1024 * 1024;
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function upload(request: IncomingMessage): Promise<CreateVideo> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.startsWith("multipart/form-data;")) throw new RecordError(415, "Send multipart form data.");
  const length = Number(request.headers["content-length"]);
  if (Number.isFinite(length) && length > MAX_BODY) throw new RecordError(413, "Upload exceeds the 102 MiB request limit.");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY) throw new RecordError(413, "Upload exceeds the 102 MiB request limit.");
    chunks.push(Buffer.from(chunk));
  }
  let form: FormData;
  try {
    form = await new Request("http://localhost/upload", { method: "POST", headers: { "content-type": contentType }, body: Buffer.concat(chunks) }).formData();
  } catch { throw new RecordError(400, "Malformed multipart upload."); }
  const allowed = new Set(["title", "speakerName", "sourceUrls", "transcript", "transcriptText", "video"]);
  for (const key of form.keys()) {
    if (!allowed.has(key) || form.getAll(key).length !== 1) throw new RecordError(400, "Upload contains unknown or duplicate fields.");
  }
  function field(name: string): string {
    const value = form.get(name);
    if (value === null) return "";
    if (typeof value !== "string") throw new RecordError(400, `${name} must be text.`);
    return value;
  }
  const transcript = form.get("transcript");
  if (transcript !== null && !(transcript instanceof File)) throw new RecordError(400, "transcript must be a file; use transcriptText for pasted text.");
  const transcriptText = field("transcriptText");
  const hasTranscriptFile = transcript instanceof File && transcript.size > 0;
  const hasTranscriptText = Boolean(transcriptText.trim());
  if (hasTranscriptFile && hasTranscriptText) throw new RecordError(400, "Provide a transcript file or pasted transcript text, not both.");
  if (!hasTranscriptFile && !hasTranscriptText) throw new RecordError(400, "Paste the transcript or upload a transcript file.");
  if ((hasTranscriptFile && transcript.size > 1024 * 1024) || Buffer.byteLength(transcriptText, "utf8") > 1024 * 1024) throw new RecordError(413, "Transcript must be at most 1 MiB.");
  const video = form.get("video");
  if (video !== null && !(video instanceof File)) throw new RecordError(400, "Video must be a file.");
  if (video instanceof File && video.size > 100 * 1024 * 1024) throw new RecordError(413, "Video must be at most 100 MiB.");
  return {
    title: field("title"), speakerName: field("speakerName"),
    sourceUrls: field("sourceUrls").split(/\r?\n/).map(url => url.trim()).filter(Boolean),
    transcript: hasTranscriptFile ? new Uint8Array(await transcript.arrayBuffer()) : Buffer.from(transcriptText, "utf8"),
    video: video instanceof File && video.size ? { name: video.name, mimeType: video.type, bytes: new Uint8Array(await video.arrayBuffer()) } : null,
  };
}

export function createVideoServer(service: VideoService, webDirectory = resolve("web")) {
  let processing = false;
  const server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = request.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) throw new RecordError(403, "Use the local server address.");
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (request.headers.origin && request.headers.origin !== url.origin) throw new RecordError(403, "Cross-origin requests are not allowed.");
      if (request.method === "GET" && url.pathname === "/api/schema") return json(response, 200, recordSchema);
      if (request.method === "GET" && url.pathname === "/api/videos") return json(response, 200, await service.list());
      if (request.method === "POST" && url.pathname === "/api/videos") {
        if (processing) throw new RecordError(429, "A video is already being processed. Wait for it to finish before submitting another.");
        processing = true;
        const controller = new AbortController();
        const cancel = () => { if (!response.writableEnded) controller.abort(); };
        request.once("aborted", cancel);
        response.once("close", cancel);
        try {
          const input = await upload(request);
          const record = await service.create(input, controller.signal);
          return json(response, 201, record);
        } finally {
          processing = false;
          request.off("aborted", cancel);
          response.off("close", cancel);
        }
      }
      const recordRoute = /^\/api\/videos\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && recordRoute) return json(response, 200, await service.get(decodeURIComponent(recordRoute[1]!)));
      const artifactRoute = /^\/api\/videos\/([^/]+)\/files\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && artifactRoute) {
        const artifact = await service.artifact(decodeURIComponent(artifactRoute[1]!), decodeURIComponent(artifactRoute[2]!));
        let start = 0;
        let end = artifact.size - 1;
        const range = request.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (!match[1] && !match[2])) { response.writeHead(416, { "content-range": `bytes */${artifact.size}` }).end(); return; }
          start = match[1] ? Number(match[1]) : Math.max(0, artifact.size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= artifact.size) {
            response.writeHead(416, { "content-range": `bytes */${artifact.size}` }).end(); return;
          }
          response.setHeader("content-range", `bytes ${start}-${end}/${artifact.size}`);
        }
        response.writeHead(range ? 206 : 200, { "content-type": artifact.type, "content-length": end - start + 1, "accept-ranges": "bytes" });
        const stream = createReadStream(artifact.path, { start, end });
        stream.on("error", () => response.destroy());
        response.on("close", () => stream.destroy());
        stream.pipe(response);
        return;
      }
      const assets: Record<string, [string, string]> = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/style.css": ["style.css", "text/css; charset=utf-8"],
      };
      const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : undefined;
      if (request.method === "GET" && asset) {
        const content = await readFile(resolve(webDirectory, asset[0]));
        response.writeHead(200, { "content-type": asset[1] }).end(content);
        return;
      }
      throw new RecordError(404, "Not found.");
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      json(response, error instanceof RecordError ? error.status : error instanceof URIError ? 400 : 502,
        { error: error instanceof RecordError ? error.message : error instanceof URIError ? "Invalid URL encoding." : publicError(error) });
    }
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 30_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RecordError(400, "PORT must be between 1 and 65535.");
    const service = new VideoService(resolve("data"), new CodexVideoAnalyzer(loadConfig));
    const server = createVideoServer(service);
    server.on("error", () => { console.error("Could not start the local video service. Check whether PORT is already in use."); process.exitCode = 1; });
    server.listen(port, "127.0.0.1", () => console.log(`Video records: http://127.0.0.1:${port}`));
    for (const event of ["SIGINT", "SIGTERM"] as const) process.once(event, () => { server.close(); server.closeAllConnections(); });
  } catch (error) { console.error(error instanceof RecordError ? error.message : publicError(error)); process.exitCode = 1; }
}
