# Debate Practice Assistant

A local CLI for practicing a debate against an assistant. Enter a topic, review an affirmative and a negative position on one motion, choose your side, and exchange arguments with the opposing assistant.

Codex is the agent harness, accessed through the official TypeScript Codex SDK. Nebius is the initial model provider. The API base URL and model are configurable; the endpoint must support the Responses protocol used by the pinned Codex runtime.

## Setup

Use Node.js 24 or later and npm. The repository's `.nvmrc` selects the Node.js 24 LTS family.

```sh
npm ci
cp .env.example .env
```

Edit `.env` with your own settings:

```dotenv
NEBIUS_BASE_URL=https://api.tokenfactory.nebius.com/v1
NEBIUS_API_KEY=your-key
NEBIUS_MODEL=your-model-id
```

The example host is not a fallback. All three variables are required. You can also export them in your shell; existing environment values take precedence over `.env`. The application loads `.env` through Node.js, without an additional dotenv dependency.

Use the complete base URL, including a version or deployment prefix, without appending `/responses` or `/chat/completions`. For another compatible provider, change these same variables. Remote endpoints require HTTPS; HTTP loopback endpoints are supported for local tests.

## Run

```sh
npm start
```

1. Enter a topic such as `AI in education`.
2. Review the motion and two opposing positions. Use `/regenerate` or `/topic <new topic>` to change them.
3. Enter `a` for affirmative or `n` for negative. The assistant takes the opposite side and generates its opening arguments.
4. Type your argument or question, then press Enter for each contribution.
5. Use `/end` to end practice, `/new` for another session, or `/quit` to exit.

Use `/retry` after failed generation. The pending contribution is retained and is not committed twice. Failed practice threads are rebuilt from the confirmed conversation before retrying. `/end`, `/new`, `/quit`, and Ctrl+C also work during generation; late results are ignored.

`npm start -- --help` shows all commands without requiring provider credentials. Each contribution is a single line of text. The interface displays completed assistant messages rather than partial output.

## Verify the configured endpoint

```sh
npm run check:provider
```

This command uses your configured model and consumes provider credits. It checks position generation, opening arguments, and two follow-up turns through the real Codex SDK, then prints the transcript for you to assess side consistency and response quality. A completed request to a Chat Completions endpoint does not establish Codex compatibility.

The app does not fall back to OpenAI or another endpoint. Authentication, protocol, and generation failures produce sanitized messages. Generation has a two-minute timeout and no automatic transport retries; position output gets at most one content repair attempt.

## Development

```sh
npm run typecheck
npm test
npm run build
```

The tests cover debate state, both side assignments, retries, cancellation, output validation, and configuration. Integration tests use the actual pinned Codex SDK and runtime against a local HTTP Responses fixture; no Nebius credentials or paid requests are needed. These tests need permission to listen on loopback. CLI tests exercise topic selection, side selection, interaction, and cancellation in a child process.

The SDK and Codex runtime are pinned to `0.164.0`. Build dependency versions are pinned in `package.json` and `package-lock.json`.

## Runtime boundaries and storage

Each application process uses a private temporary Codex home and working directory. It does not load your personal Codex sign-in, provider configuration, or integrations. Debate instructions replace coding instructions. Execution, browsing, image, plugin, and subagent capabilities are disabled; the runtime uses a read-only sandbox with no approval escalation. The adapter rejects non-text tool events.

Session state is held in memory. Codex may write conversation history and diagnostics inside the private temporary runtime directory while the application is running; that directory is removed on normal shutdown. An abrupt kill or crash can leave temporary files behind. There is no cross-process resume or saved-session browser in this version. Conversations are sent to the configured provider for inference.

Never commit `.env` or put credentials in a topic. `.env`, build output, and dependencies are ignored by Git.

## Video records

The [video data index](data/README.md) lists saved source videos. Each video has its own folder containing source links, the complete supplied transcript, extracted speaker remarks and a timestamped summary.

## Design documents

- [Product intent](doc/intent.md)
- [Behavior specification](doc/spec.md)
- [Technology stack](doc/tech-stack.md)

Structured competition rounds, judging, scoring, voice, and a graphical interface remain in the backlog.
