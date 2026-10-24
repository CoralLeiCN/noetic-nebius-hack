import { Codex, type Thread, type ThreadOptions } from "@openai/codex-sdk";
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile, stat, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderConfig } from "./config.js";
import { type DebateAgent, type PracticeContext, type Positions, parsePositions } from "./debate.js";
import { DebateError } from "./errors.js";
import { loadSpeakingStyle } from "./speaking-style.js";
import { DEBATE_INSTRUCTIONS, POSITION_REPAIR_PROMPT, preparationPrompt, positionRecoveryPrompt, practicePrompt } from "./prompts/debate.js";

const OAUTH_LOGIN_MESSAGE = "Persona generation requires a file-backed Codex ChatGPT login. Run codex -c 'cli_auth_credentials_store=\"file\"' login, then retry.";
// Codex refreshes shared file-backed credentials during use. Avoid concurrent
// refreshes from multiple persona generations within this server process.
let oauthRun: Promise<void> = Promise.resolve();

export interface CodexRuntimeOptions {
  requestTimeoutMs?: number;
}

async function oauthAuthPath(): Promise<string> {
  try {
    const path = await realpath(join(resolve(process.env.CODEX_HOME || join(homedir(), ".codex")), "auth.json"));
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 1_048_576) throw new Error("Invalid auth file");
    const auth: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new Error("Invalid auth data");
    const data = auth as Record<string, unknown>;
    const tokens = data.tokens as Record<string, unknown> | undefined;
    if ((data.auth_mode !== undefined && data.auth_mode !== "chatgpt") || data.OPENAI_API_KEY ||
        !tokens || ["id_token", "access_token", "refresh_token"].some(key => typeof tokens[key] !== "string" || !tokens[key].trim())) {
      throw new Error("ChatGPT login required");
    }
    return path;
  } catch {
    // Never expose auth-file contents, token values, or parser diagnostics.
    throw new DebateError(OAUTH_LOGIN_MESSAGE);
  }
}

function rejectsResponseHistory(error: unknown): boolean {
  return error instanceof Error && /ChatCompletionRequest/.test(error.message) &&
    /output_text/.test(error.message) && /validation|valid string/.test(error.message);
}

export class CodexDebateAgent implements DebateAgent {
  private practiceThread: Thread | null = null;
  private freshPracticeRequests = false;
  private preparationId: string | null = null;
  private readonly options: ThreadOptions;

  private constructor(
    private readonly codex: Codex,
    private readonly runtimeRoot: string,
    model?: string,
    private readonly oauth = false,
    private readonly speakingStyle: string | null = null,
    private readonly requestTimeoutMs = 120_000,
  ) {
    this.options = {
      ...(model ? { model } : {}),
      workingDirectory: join(runtimeRoot, "workspace"),
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    };
  }

  static async create(config: ProviderConfig, instructions?: string, options: CodexRuntimeOptions = {}): Promise<CodexDebateAgent> {
    const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 600_000) {
      throw new DebateError("The generation request timeout must be between 1 and 600,000 milliseconds.");
    }
    const speakingStyle = instructions === undefined ? await loadSpeakingStyle() : null;
    return this.createRuntime(instructions ?? DEBATE_INSTRUCTIONS, config, undefined, speakingStyle, requestTimeoutMs);
  }

  static async createOAuth(instructions: string): Promise<CodexDebateAgent> {
    const authPath = await oauthAuthPath();
    return this.createRuntime(instructions, undefined, authPath);
  }

  private static async createRuntime(instructions: string, config?: ProviderConfig, authPath?: string, speakingStyle: string | null = null, requestTimeoutMs = 120_000): Promise<CodexDebateAgent> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "debate-runtime-")));
    try {
      const stateDirectory = join(root, "codex");
      const instructionsPath = join(root, "instructions.md");
      await mkdir(stateDirectory, { mode: 0o700 });
      await mkdir(join(root, "workspace"), { mode: 0o700 });
      await writeFile(instructionsPath, instructions, { mode: 0o600 });
      // Only credentials are shared with the existing login. Config, tools,
      // instructions, history and generated outputs stay in the private runtime.
      // A symlink lets the CLI refresh auth.json in place without copying tokens.
      if (authPath) await symlink(authPath, join(stateDirectory, "auth.json"));
      // An explicit environment prevents personal Codex credentials, config,
      // integrations, and unrelated API keys from being inherited.
      const env: Record<string, string> = {
        CODEX_HOME: stateDirectory,
        ...(config ? { NEBIUS_API_KEY: config.apiKey } : {}),
      };
      for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TMPDIR", "TMP", "TEMP", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
        if (process.env[key]) env[key] = process.env[key]!;
      }
      const codex = new Codex({
        env,
        config: {
          model_provider: config ? "nebius" : "openai",
          ...(!config ? { cli_auth_credentials_store: "file", forced_login_method: "chatgpt" } : {}),
          model_instructions_file: instructionsPath,
          model_reasoning_summary: "none",
          // GLM-5.3-Flash defaults to max thinking when effort is omitted.
          // Request its supported low budget for these short debate tasks.
          ...(config?.model === "zai-org/GLM-5.3-Flash" ? { model_reasoning_effort: "low" } : {}),
          suppress_unstable_features_warning: true,
          web_search: "disabled",
          mcp_servers: {},
          features: {
            shell_tool: false, multi_agent: false, apps: false, plugins: false,
            remote_plugin: false, browser_use: false, computer_use: false,
            image_generation: false, goals: false, shell_snapshot: false,
            view_image: false,
            code_mode_host: false, workspace_dependencies: false,
            skill_mcp_dependency_install: false, skill_search: false,
            skip_host_skill_discovery: true, enable_request_compression: false,
            unbounded_connection_retries: false,
          },
          skills: {
            config: ["imagegen", "openai-docs", "skill-creator", "skill-installer"].map(name => ({
              path: join(stateDirectory, "skills", ".system", name, "SKILL.md"),
              enabled: false,
            })),
          },
          ...(config ? { model_providers: {
            nebius: {
              name: "Configured debate endpoint",
              base_url: config.baseUrl,
              env_key: "NEBIUS_API_KEY",
              wire_api: "responses",
              requires_openai_auth: false,
              supports_websockets: false,
              request_max_retries: 2,
              stream_max_retries: 0,
            },
          } } : {}),
        },
      });
      return new CodexDebateAgent(codex, root, config?.model || process.env.CODEX_PERSONA_MODEL?.trim(), Boolean(authPath), speakingStyle, requestTimeoutMs);
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  get threadIds(): { preparation: string | null; practice: string | null } {
    return { preparation: this.preparationId, practice: this.practiceThread?.id ?? null };
  }

  /** A fresh, isolated SDK thread for a schema-constrained service task. */
  async structured(prompt: string, outputSchema: unknown, signal: AbortSignal): Promise<string> {
    return this.run(this.codex.startThread(this.options), prompt, signal, outputSchema);
  }

  async prepare(topic: string, signal: AbortSignal): Promise<Positions> {
    let thread = this.codex.startThread(this.options);
    const task = preparationPrompt(topic);
    let output = await this.run(thread, task, signal);
    this.preparationId = thread.id;
    try { return parsePositions(output); }
    catch {
      // One content repair; HTTP retries are bounded by the provider settings.
      const repair = POSITION_REPAIR_PROMPT;
      try { output = await this.run(thread, repair, signal); }
      catch (error) {
        if (signal.aborted || !rejectsResponseHistory(error)) throw error;
        this.freshPracticeRequests = true;
        thread = this.codex.startThread(this.options);
        output = await this.run(thread, positionRecoveryPrompt(task, output), signal);
        this.preparationId = thread.id;
      }
      return parsePositions(output);
    }
  }

  async opening(context: PracticeContext, signal: AbortSignal): Promise<string> {
    this.resetPractice();
    return this.practice(context, null, signal);
  }

  async reply(context: PracticeContext, contribution: string, signal: AbortSignal): Promise<string> {
    return this.practice(context, contribution, signal);
  }

  resetPractice(): void { this.practiceThread = null; }

  async dispose(): Promise<void> {
    this.resetPractice();
    await rm(this.runtimeRoot, { recursive: true, force: true });
  }

  private async practice(context: PracticeContext, contribution: string | null, signal: AbortSignal): Promise<string> {
    const fresh = this.freshPracticeRequests || !this.practiceThread;
    const thread = fresh ? this.codex.startThread(this.options) : this.practiceThread!;
    this.practiceThread = thread;
    try {
      return await this.run(thread, practicePrompt(context, contribution, fresh, this.speakingStyle), signal);
    } catch (error) {
      // A failed runtime may have advanced its own history. Rebuild from the
      // application's confirmed transcript on retry, avoiding duplicate turns.
      if (this.practiceThread === thread) this.practiceThread = null;
      // Some Responses-to-Chat gateways reject output_text history on a resumed
      // thread. Only that explicit validation failure gets one fresh request;
      // confirmed messages travel as debate data, preserving the conversation.
      if (!fresh && contribution !== null && !signal.aborted && rejectsResponseHistory(error)) {
        this.freshPracticeRequests = true;
        return this.practice(context, contribution, signal);
      }
      throw error;
    }
  }

  private async run(thread: Thread, prompt: string, signal: AbortSignal, outputSchema?: unknown): Promise<string> {
    if (!this.oauth) return this.runTurn(thread, prompt, signal, outputSchema);
    const previous = oauthRun;
    let release!: () => void;
    oauthRun = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      signal.throwIfAborted();
      return await this.runTurn(thread, prompt, signal, outputSchema);
    } finally { release(); }
  }

  private async runTurn(thread: Thread, prompt: string, signal: AbortSignal, outputSchema?: unknown): Promise<string> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const abort = new AbortController();
    const combined = AbortSignal.any([signal, timeout, abort.signal]);
    try {
      const { events } = await thread.runStreamed(prompt, { signal: combined, ...(outputSchema ? { outputSchema } : {}) });
      let finalResponse = "";
      let completed = false;
      let diagnostic: string | null = null;
      for await (const event of events) {
        // The CLI also emits nonfatal startup warnings as `error` events,
        // including missing catalog metadata for custom model identifiers.
        if (event.type === "error") diagnostic = event.message;
        if (event.type === "turn.failed") throw new Error(event.error.message);
        if (event.type === "item.started" || event.type === "item.completed") {
          const item = event.item;
          if (!["agent_message", "reasoning", "error"].includes(item.type)) {
            abort.abort();
            throw new DebateError("The model attempted a tool action. This application supports text generation only.");
          }
          if (item.type === "error") diagnostic = item.message;
          if (event.type === "item.completed" && item.type === "agent_message") finalResponse = item.text;
        }
        if (event.type === "turn.completed") completed = true;
      }
      combined.throwIfAborted();
      if (!completed && diagnostic) throw new Error(diagnostic);
      if (!completed || !finalResponse.trim()) throw new DebateError("The provider did not complete a text response. Check Responses compatibility and retry.");
      return finalResponse.trim();
    } catch (error) {
      if (timeout.aborted && !signal.aborted) {
        const minutes = this.requestTimeoutMs % 60_000 === 0;
        const amount = this.requestTimeoutMs / (minutes ? 60_000 : 1000);
        const duration = `${amount} ${minutes ? "minute" : "second"}${amount === 1 ? "" : "s"}`;
        throw new DebateError(`Generation timed out after ${duration}. Retry to continue from the last completed step.`);
      }
      if (this.oauth && error instanceof Error && /\b(401|403)\b|unauthorized|authentication|refresh.token|login|sign.in/i.test(error.message)) {
        throw new DebateError("Codex ChatGPT authentication failed. Run codex login and retry persona generation.");
      }
      throw error;
    }
  }
}
