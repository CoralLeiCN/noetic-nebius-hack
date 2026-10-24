import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, lstat, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex, type CodexOptions, type Thread, type ThreadOptions } from "@openai/codex-sdk";
import { CodexDebateAgent } from "../src/codex-agent.js";
import { DebateSession } from "../src/debate.js";
import { providerFixture, POSITIONS } from "./fixture.js";

const AUTH = {
  auth_mode: "chatgpt", OPENAI_API_KEY: null,
  tokens: { id_token: "fixture-id", access_token: "fixture-access", refresh_token: "fixture-refresh" },
};

test("Codex OAuth reuses only a file-backed ChatGPT login", async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "debate-oauth-test-")));
  const original = { CODEX_HOME: process.env.CODEX_HOME, CODEX_PERSONA_MODEL: process.env.CODEX_PERSONA_MODEL, OPENAI_API_KEY: process.env.OPENAI_API_KEY, NEBIUS_API_KEY: process.env.NEBIUS_API_KEY };
  process.env.CODEX_HOME = home;
  delete process.env.CODEX_PERSONA_MODEL;
  process.env.OPENAI_API_KEY = "environment-openai-secret";
  process.env.NEBIUS_API_KEY = "environment-nebius-secret";
  try {
    await t.test("missing, invalid, API-key and external-token credentials fail without disclosing contents", async () => {
      const rejects = async () => assert.rejects(CodexDebateAgent.createOAuth("Extract a persona"), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /file-backed Codex ChatGPT login/);
        assert.doesNotMatch(error.message, /fixture-secret|fixture-access|fixture-refresh/);
        return true;
      });
      await rejects();
      for (const content of ["fixture-secret malformed", JSON.stringify({ OPENAI_API_KEY: "fixture-secret" }),
        JSON.stringify({ ...AUTH, auth_mode: "apikey" }), JSON.stringify({ ...AUTH, auth_mode: "chatgptAuthTokens" }),
        JSON.stringify({ ...AUTH, tokens: { access_token: "fixture-access" } })]) {
        await writeFile(join(home, "auth.json"), content, { mode: 0o600 });
        await rejects();
      }
    });

    await t.test("runtime shares auth through a symlink while isolating config, instructions, history and keys", async () => {
      await writeFile(join(home, "auth.json"), JSON.stringify(AUTH), { mode: 0o600 });
      let captured: CodexOptions | undefined;
      let threadOptions: ThreadOptions | undefined;
      const stub = mock.method(Codex.prototype, "startThread", function (this: Codex, options?: ThreadOptions) {
        captured = (this as unknown as { options: CodexOptions }).options;
        threadOptions = options;
        return { runStreamed: async () => ({ events: (async function* () {
          yield { type: "item.completed", item: { type: "agent_message", text: "persona result" } };
          yield { type: "turn.completed" };
        })() }) } as unknown as Thread;
      });
      const agent = await CodexDebateAgent.createOAuth("Extract a persona without operational commentary.");
      let stateDirectory = "";
      try {
        assert.equal(await agent.structured("Build persona", {}, new AbortController().signal), "persona result");
        assert.ok(captured?.env);
        stateDirectory = captured.env.CODEX_HOME!;
        assert.notEqual(stateDirectory, home);
        assert.equal((await lstat(stateDirectory)).mode & 0o777, 0o700);
        assert.ok((await lstat(join(stateDirectory, "auth.json"))).isSymbolicLink());
        assert.equal(await readlink(join(stateDirectory, "auth.json")), join(home, "auth.json"));
        assert.equal(captured.env.OPENAI_API_KEY, undefined);
        assert.equal(captured.env.CODEX_API_KEY, undefined);
        assert.equal(captured.env.NEBIUS_API_KEY, undefined);
        assert.equal(captured.apiKey, undefined);
        assert.equal(captured.baseUrl, undefined);
        const config = captured.config!;
        assert.equal(config.model_provider, "openai");
        assert.equal(config.cli_auth_credentials_store, "file");
        assert.equal(config.forced_login_method, "chatgpt");
        assert.equal(config.model_providers, undefined);
        assert.deepEqual(config.mcp_servers, {});
        assert.equal((config.features as Record<string, boolean>).shell_tool, false);
        assert.equal((config.features as Record<string, boolean>).apps, false);
        assert.equal((config.features as Record<string, boolean>).multi_agent, false);
        assert.equal(await readFile(config.model_instructions_file as string, "utf8"), "Extract a persona without operational commentary.");
        assert.equal(threadOptions?.model, undefined);
        assert.equal(threadOptions?.sandboxMode, "read-only");
        assert.equal(threadOptions?.approvalPolicy, "never");
        assert.equal(threadOptions?.networkAccessEnabled, false);
        assert.equal(threadOptions?.webSearchMode, "disabled");
        assert.doesNotMatch(JSON.stringify(captured), /fixture-access|fixture-refresh|environment-openai-secret|environment-nebius-secret/);
        // The CLI can persist a refreshed login through the link; disposing the
        // generation runtime must leave that login available for the next run.
        await writeFile(join(stateDirectory, "auth.json"), JSON.stringify({ ...AUTH, last_refresh: "refreshed" }));
      } finally { await agent.dispose(); stub.mock.restore(); }
      await assert.rejects(lstat(stateDirectory), { code: "ENOENT" });
      assert.equal(JSON.parse(await readFile(join(home, "auth.json"), "utf8")).last_refresh, "refreshed");
    });

    await t.test("optional persona model is passed explicitly and authentication failures are sanitized", async () => {
      process.env.CODEX_PERSONA_MODEL = "fixture-persona-model";
      const stub = mock.method(Codex.prototype, "startThread", function (_options?: ThreadOptions) {
        assert.equal(_options?.model, "fixture-persona-model");
        return { runStreamed: async () => { throw new Error("401 authentication failed: fixture-access fixture-refresh"); } } as unknown as Thread;
      });
      const agent = await CodexDebateAgent.createOAuth("Extract a persona");
      try {
        await assert.rejects(agent.structured("Build persona", {}, new AbortController().signal), error => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Codex ChatGPT authentication failed/);
          assert.doesNotMatch(error.message, /fixture-access|fixture-refresh|NEBIUS/);
          return true;
        });
      } finally { await agent.dispose(); stub.mock.restore(); }
    });
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("real SDK practice receives persona style without source records", { timeout: 60_000 }, async () => {
  const fixture = await providerFixture((_request, index) => index === 0 ? JSON.stringify(POSITIONS) : "A concise rebuttal.");
  const agent = await CodexDebateAgent.create({ baseUrl: fixture.baseUrl, apiKey: "fixture-secret", model: "fixture-model" });
  try {
    const session = new DebateSession(agent, { personaId: "persona-fixture", name: "Example speaker", personaMarkdown: "Use plain vocabulary, short sentences and practical counterexamples." });
    await session.prepare("AI in education");
    await session.choose("negative");
    const opening = JSON.stringify(fixture.requests[1]?.body.input);
    assert.match(opening, /plain vocabulary, short sentences and practical counterexamples/);
    assert.match(opening, /vocabulary, register, rhetoric, argument structure/);
    assert.match(opening, /simulation, never the actual person/);
    assert.match(opening, /no source transcript or source-library access/);
    assert.doesNotMatch(opening, /"remarks"|"sources"|"transcript"|"cueId"/);
  } finally { await agent.dispose(); await fixture.close(); }
});
