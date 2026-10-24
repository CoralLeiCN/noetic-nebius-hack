import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";

export const POSITIONS = {
  motion: "Schools should allow AI for homework.",
  affirmative: "Schools should allow AI for homework.",
  negative: "Schools should not allow AI for homework.",
};
export interface RequestRecord {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}
export type FixtureReply = string | { status: number; body: string };

export async function providerFixture(respond: (request: RequestRecord, index: number) => FixtureReply | Promise<FixtureReply>, modelIds: string[] = []) {
  const requests: RequestRecord[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/custom/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: modelIds.map(id => ({ id })) }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body: Record<string, unknown>;
    try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
    catch { response.writeHead(400).end(); return; }
    const record = { path: request.url ?? "", headers: request.headers, body };
    requests.push(record);
    const result = await respond(record, requests.length - 1);
    if (response.destroyed) return;
    if (typeof result !== "string") {
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(result.body);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const id = `resp_fixture_${requests.length}`;
    const itemId = `msg_fixture_${requests.length}`;
    const item = {
      id: itemId, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: result, annotations: [] }],
    };
    const output = { id, object: "response", model: body.model, status: "in_progress", output: [] as unknown[] };
    let sequence = 0;
    function send(event: Record<string, unknown> & { type: string }) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`);
    }
    send({ type: "response.created", response: output });
    send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
    send({ type: "response.content_part.added", item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    send({ type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: result });
    send({ type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text: result });
    send({ type: "response.content_part.done", item_id: itemId, output_index: 0, content_index: 0, part: item.content[0] });
    send({ type: "response.output_item.done", output_index: 0, item });
    send({ type: "response.completed", response: {
      ...output, status: "completed", output: [item],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    } });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not start.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/custom/v1`, requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
