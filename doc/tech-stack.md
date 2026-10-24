# Debate Assistant Technology Stack

Status: Local CLI, web practice, source records and persona compilation implemented. This document is self-contained and records technology decisions independently of the product specification. The Codex SDK and runtime are pinned to `0.164.0`; live Nebius compatibility still requires the configured provider check.

## System overview

A local web app and text CLI help a human debate an assistant. The application owns source records, compiled speaker personas, the topic, opposing positions, side selection and transcript. Codex owns model execution and conversation threads. Nebius supplies source extraction and debate inference through a configurable endpoint. Persona compilation uses Codex with the existing ChatGPT OAuth login.

```text
Source records
  -> Codex SDK with ChatGPT OAuth
  -> Speaker persona Markdown
  -> Web speaker selector

Human
  -> Web or text interface
  -> Debate session service
  -> Codex SDK
  -> Codex runtime / agent harness
  -> Configured Nebius or compatible model endpoint
```

## Stack and decision status

| Layer | Technology | Status and reason |
| --- | --- | --- |
| Agent harness | Codex runtime | Required by the user; runs the assistant's model interactions. |
| Harness integration | Official `@openai/codex-sdk` package, version `0.164.0` | Implemented with the matching pinned Codex runtime. |
| Source and practice model provider | Nebius | Configurable compatible endpoint and web model selection. |
| Persona compiler authentication | Codex ChatGPT OAuth | Reuses an existing Codex login; no provider API-key fallback. |
| Speaker representation | Saved `persona.md` with `persona.json` metadata | Compiled from validated source records; only the Markdown enters practice as speaker context. |
| Model transport | OpenAI Responses-compatible API | Required by the current Codex provider configuration. |
| Endpoint configuration | Environment variables mapped to Codex provider overrides | Required; endpoint changes must not require a code change. |
| Application language | TypeScript `7.0.2` | Implemented; shares types with the SDK. |
| Runtime | Node.js 24 or later | `.nvmrc` selects the Node.js 24 LTS family; `@types/node` is pinned to `24.19.2`. |
| Package manager | npm with a committed lockfile | Implemented; pins the SDK and its compatible Codex runtime together. |
| Interfaces | Local web app and command-line text interface using Node.js built-ins | Implemented without a frontend framework. |
| Application structure | A small session service plus a Codex adapter | Implemented; keeps debate rules separate from SDK and provider details. |
| Runtime validation | Explicit validation and Ajv | Configuration, strict source-record schemas, quote fidelity and persona validation. |
| Session state | In-memory application state and Codex thread identifiers | Implemented without an application database. Codex writes temporary local thread data. |
| Tests | Node.js test runner and a configurable local provider fixture | Implemented; exercises domain behavior, actual SDK routing, and the CLI. |
| Deployment | Local Node.js process with outbound access to the configured provider | Implemented; hosted deployment is outside the initial scope. |
| Logging | Sanitized application diagnostics | Implemented; no separate monitoring service. |

No frontend framework, HTTP server framework, database, vector store, additional agent framework, or hosting service is selected for the first version.

The official [Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk) describes server-side TypeScript integration, thread creation and continuation, and configuration overrides. The final package and runtime versions must be recorded in the implementation lockfile and setup documentation.

## Codex integration

The application must call the Codex SDK rather than making direct model requests as its debate execution path. Codex remains the harness when the provider changes.

The adapter:

1. Validate environment configuration before starting a model operation.
2. Create a Codex instance with explicit custom provider configuration using SDK configuration overrides.
3. Use a preparation thread to generate the motion and opposing positions.
4. Start a separate practice thread once sides are selected, supplying the accepted motion, both positions, the assistant's assigned side and the selected persona Markdown. The preparation thread receives the topic only.
5. Continue the same practice thread for follow-up turns using the SDK's thread API.
6. Return completed assistant text and normalized failures to the session service.

The application owns session state and completed messages. Codex thread state supplies conversational context; it does not decide side assignments or application transitions. Provider configuration is fixed for a session, so switching endpoint or model starts a new session.

Use dedicated debate instructions instead of Codex's default coding instructions. Run in a dedicated application working directory, with shell execution, file changes, web search, external integrations, and subagents disabled or denied. The debate workflow requires only model conversation. Verify these restrictions against the pinned runtime; prompt instructions alone are insufficient to restrict tools.

Use process-scoped SDK overrides and isolated application runtime state. Do not edit the developer's personal Codex configuration or inherit unrelated personal integrations. The SDK supports configuration overrides without changing configuration files. [Codex SDK configuration](https://learn.chatgpt.com/docs/codex-sdk#configuration-overrides)

## Persona compilation

The canonical generator prompt is `PERSONA_GENERATION_PROMPT` in [`src/prompts/persona-generation.ts`](../src/prompts/persona-generation.ts). `CodexPersonaAnalyzer` imports it from that file; generation requirements belong there. Its `guidance` requirements produce direct second-person agent instructions, while tracing details belong in separate analysis fields retained in `persona.json`.

`PersonaService` reads validated saved source records for one normalized speaker name. The compiler analyzes the speaker's observed language and vocabulary, sentence rhythm, tone and register, rhetoric, argument structure, evidence use, interaction and rebuttal habits, and treatment of uncertainty and values. Each dimension includes observations, source evidence, confidence and practical guidance in `persona.json`, alongside limitations and source provenance for tracing. `persona.md` renders direct agent instructions from the practical guidance and excludes the tracing analysis. Inadequate evidence must remain explicit in the analysis and produce neutral practice behavior; transcript text does not establish acoustic voice characteristics or the person's views on unrelated topics.

The compiler uses a fresh Codex SDK thread authenticated with the existing file-backed ChatGPT OAuth login. Use `codex -c 'cli_auth_credentials_store="file"' login`; an API-key or keyring-only login is not used. It does not use the Nebius credentials and does not fall back to that provider. Task instructions, tool restrictions and temporary history stay isolated from unrelated personal configuration. See [Codex authentication](https://learn.chatgpt.com/docs/auth) for login caching and credential storage.

Input is capped at 120,000 serialized characters and rejected explicitly when over the limit, without silent truncation. Compiled Markdown is capped at 48,000 characters.

Compiled versions are published under `data/persona-<uuid>/` as `persona.md` and `persona.json`. The persona list returns the latest version per normalized speaker name. A debate loads the saved Markdown into `{ personaId, name, personaMarkdown }` and deep-clones it into its session. It does not load the tracing analysis, source transcripts, extracted remarks or summaries. A rebuild produces a new version and affects only subsequently created debates. Previously saved personas require a rebuild to adopt the instruction-only Markdown format. Compilation creates prompt context rather than changing model weights.

## Environment configuration

The Nebius settings configure source extraction and practice. Codex login settings configure the separate persona compiler. These are application-level settings. The configuration loader must resolve them into actual Codex configuration values; Codex TOML does not perform the substitution shown in the illustrative example below.

| Variable | Required | Meaning |
| --- | --- | --- |
| `NEBIUS_BASE_URL` | Yes | Complete API base URL, including any version or deployment prefix; omit the final `/responses` operation path. Accept a compatible custom endpoint here. |
| `NEBIUS_API_KEY` | Yes | Provider bearer token, supplied only through the process environment or an untracked local environment file. |
| `NEBIUS_MODEL` | For CLI, source extraction and provider checks | Exact model identifier accepted by the configured endpoint; web practice may select a model instead. |
| `CODEX_HOME` | No | Codex login location, defaulting to `~/.codex`; persona compilation requires a ChatGPT OAuth login there. |
| `CODEX_PERSONA_MODEL` | No | Model for persona compilation; omit to use the Codex default available to the signed-in account. |

The repository's `.env.example` provides this template:

```dotenv
NEBIUS_BASE_URL=https://api.tokenfactory.nebius.com/v1
NEBIUS_API_KEY=
NEBIUS_MODEL=
```

The URL is an example, not a built-in fallback. Require an explicit value so regional, dedicated, proxy, or other compatible endpoints work without code changes. Preserve the configured path prefix, normalize a trailing slash, and reject URLs containing embedded credentials. Use HTTPS for remote endpoints; allow HTTP loopback URLs for local compatibility tests.

The selected model must be verified with the configured endpoint. Neither a model's name nor its availability on another provider establishes compatibility.

### Mapping to Codex

The application supplies the equivalent of the following provider configuration through SDK overrides after resolving environment variables:

```toml
model = "<resolved NEBIUS_MODEL>"
model_provider = "nebius"

[model_providers.nebius]
name = "Configured debate model endpoint"
base_url = "<resolved NEBIUS_BASE_URL>"
env_key = "NEBIUS_API_KEY"
wire_api = "responses"
requires_openai_auth = false
```

Pass the API key to the Codex runtime environment. Never put its literal value in a command-line argument, configuration example, or model prompt. The provider ID `nebius` is an application configuration label; the base URL determines the request destination.

Codex documents custom providers with `base_url`, `env_key`, optional headers, and `wire_api`. Its current reference specifies `responses` as the only supported wire protocol. Use SDK overrides for this configuration: project-local `.codex/config.toml` files cannot set provider/authentication overrides in the current documented configuration model. [Custom providers](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

If an endpoint needs additional headers or query parameters, expose explicit configuration for the documented Codex provider fields during implementation. Resolve secret header values from environment variables; do not store them in the repository.

## Nebius compatibility and custom endpoint support

Nebius's published [inference API index](https://api.tokenfactory.nebius.com/docs) advertises `POST /v1/responses`. This establishes an advertised route, not verified compatibility with Codex, a particular model, or the user's endpoint.

Before marking the integration supported, run an explicit compatibility check through the pinned Codex SDK and runtime using the configured environment:

1. Confirm bearer authentication and the exact configured model work.
2. Confirm the runtime's Responses requests, streamed events, and completion handling work. A successful Chat Completions request is insufficient.
3. Generate valid positions and an opening, then complete at least two follow-up turns with context preserved.
4. Verify developer instructions, supported request fields, and any schema constraints used for position generation. If schema-constrained generation is unavailable, validate parsed output and perform at most one repair attempt.
5. Verify that disabling optional model capabilities avoids sending unsupported reasoning, search, or tool parameters.
6. Verify all inference traffic goes to the configured endpoint and that no provider fallback occurs.

Changing `NEBIUS_BASE_URL`, `NEBIUS_API_KEY`, and `NEBIUS_MODEL` must be sufficient to use another endpoint that passes these checks. Credentials and protocol compatibility can vary between endpoints.

If the endpoint only supports Chat Completions or rejects the Codex request shape, report the incompatibility clearly. A Responses-compatible gateway would then be a separate integration decision; no translation gateway or alternate harness is selected in this stack.

## Data, failures, and verification

The session service stores a session ID, topic, motion, affirmative and negative positions, human and assistant sides, status, completed transcript messages, selected model and a fixed copy of the persona Markdown. The adapter holds preparation/practice thread IDs. Credentials are never session data. Durable application history and cross-process resume are deferred. Codex's history and diagnostics live in a private temporary runtime directory that is removed on normal shutdown; an abrupt kill may leave that temporary directory behind.

Validate generated positions before side selection. Each position must be nonempty, use the expected side identifier, and address the same motion. Validate shape in code and review semantic opposition with representative examples.

Own retry policy in one layer: keep provider transport retries bounded and avoid wrapping an already retried SDK operation in unbounded application retries. Do not replay a failed human turn blindly into a possibly advanced thread. Reconcile its status or rebuild a fresh thread from confirmed session context and completed messages before retrying. Log only sanitized failure details.

Verification must cover side assignment, state transitions, session isolation, invalid output, failed turns, and endpoint routing. A local fixture should assert the requested host/path/model and exercise authentication and protocol failures through the actual SDK adapter. Live Nebius checks are explicit integration tests using environment credentials, rather than ordinary offline test requirements.

## Decisions still open

- The exact Nebius endpoint and model, to be supplied through environment variables and verified together.
- Whether a later deployment needs an exact Node.js patch version beyond the selected LTS family. SDK, runtime, and build dependencies are pinned in the lockfile.
- Whether later versions need durable application storage, authentication, hosting, or additional provider-specific headers.

Live checks remain necessary for Codex compatibility with the selected Nebius endpoint and model, and for persona quality through the user's Codex OAuth account. Local fixture tests do not establish live model access or the accuracy of an inferred persona.
