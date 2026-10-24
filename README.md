# Debate Practice Assistant

A local web app and CLI for practicing a debate against an assistant. Enter a topic, review an affirmative and a negative position on one motion, choose your side, and exchange arguments with the opposing assistant. In the web app, use source material to build a speaker persona, then practice against an opponent that follows the saved persona Markdown. Arena randomly selects four distinct models, generates comparable opening speeches through the same practice module, and scores each with the existing speech judge.

Codex is the agent harness, accessed through the official TypeScript Codex SDK. Persona compilation uses your existing Codex ChatGPT OAuth login. Source extraction and debate generation use Nebius as the initial model provider. The API base URL and model are configurable; the endpoint must support the Responses protocol used by the pinned Codex runtime.

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

The example host is not a fallback. The base URL and API key are required. Web debate practice lets you choose a model in the interface without setting `NEBIUS_MODEL`; the CLI, provider check and source-record generation still use `NEBIUS_MODEL`. You can also export these values in your shell; existing environment values take precedence over `.env`. The application loads `.env` through Node.js, without an additional dotenv dependency.

For local Codex-managed worktrees, [`.worktreeinclude`](.worktreeinclude) tells Codex to copy the root `.env` from the source checkout when creating a worktree. Configure `.env` in your main checkout once; each new worktree receives its own copy, and an existing destination `.env` is preserved. Copies are snapshots: later edits are not synchronized. The credentials remain ignored by Git. This feature applies to local Codex-managed worktrees; worktrees created with `git worktree add` or on remote hosts require their own configuration. See the official [worktree documentation](https://learn.chatgpt.com/docs/environments/git-worktrees#copy-ignored-local-files-into-managed-worktrees).

To build speaker personas, sign in to Codex with ChatGPT OAuth using `codex -c 'cli_auth_credentials_store="file"' login`. The application requires a file-backed OAuth login and reuses the login associated with `CODEX_HOME` (default `~/.codex`); an API-key login does not satisfy persona compilation. `CODEX_PERSONA_MODEL` optionally selects a model available to that login. Without it, Codex chooses its default. Persona compilation has no Nebius fallback. See the official [Codex authentication documentation](https://learn.chatgpt.com/docs/auth).

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

Each completed assistant speech and submitted human argument receives a provisional score and feedback from a separate judge using the configured model. A failed evaluation keeps the speech intact; use `/judge <turn>` with the displayed one-based turn number to retry only its feedback.

`npm start -- --help` shows all commands without requiring provider credentials. Each contribution is a single line of text. The interface displays completed assistant messages rather than partial output.

## Verify the configured endpoint

```sh
npm run check:provider
```

This command uses your configured model and consumes provider credits. It checks position generation, opening arguments, and two follow-up turns through the real Codex SDK, then prints the transcript for you to assess side consistency and response quality. A completed request to a Chat Completions endpoint does not establish Codex compatibility.

Source extraction and debate generation do not fall back to OpenAI or another endpoint. Persona compilation is a separate operation that deliberately uses Codex OAuth, with no fallback to the debate provider. Authentication, protocol, and generation failures produce sanitized messages. Codex runs have a two-minute timeout, except Arena requests, which default to five minutes. Provider-backed generation allows up to two HTTP retries for retryable failures; interrupted response streams are not replayed automatically. Position output gets at most one content repair attempt.

## Development

All application prompt templates live in [`src/prompts/`](src/prompts/README.md), including debate generation, speech and Arena judging, source extraction, persona compilation, and speaking style. The index explains which file to edit and how to apply changes.

```sh
npm run typecheck
npm test
npm run build
```

The tests cover debate state, both side assignments, retries, cancellation, output validation, and configuration. Integration tests use the actual pinned Codex SDK and runtime against a local HTTP Responses fixture; no Nebius credentials or paid requests are needed. These tests need permission to listen on loopback. CLI tests exercise topic selection, side selection, interaction, and cancellation in a child process.

The SDK and Codex runtime are pinned to `0.164.0`. Build dependency versions are pinned in `package.json` and `package-lock.json`.

## Runtime boundaries and storage

Model operations use a private temporary Codex home and working directory. Source extraction and debate generation do not load your personal Codex sign-in. Persona compilation deliberately reuses your Codex OAuth login while keeping task configuration and history isolated. Neither path loads unrelated personal provider configuration or integrations. Debate instructions replace coding instructions. Execution, browsing, image, plugin, and subagent capabilities are disabled; the runtime uses a read-only sandbox with no approval escalation. The adapter rejects non-text tool events.

Session state is held in memory. Codex may write conversation history and diagnostics inside the private temporary runtime directory while the application is running; that directory is removed on normal shutdown. An abrupt kill or crash can leave temporary files behind. There is no cross-process resume or saved-session browser in this version. Practice conversations are sent to the configured debate provider for inference. Persona compilation sends the selected speaker's saved source material to Codex through your ChatGPT OAuth login.

Never commit `.env` or put credentials in a topic. `.env`, build output, and dependencies are ignored by Git.

## Web debate practice

If the speaker list fails to load, open `http://127.0.0.1:3000/api/personas` (adjust the port if configured) to see the server error. Loading the bundled saved persona requires neither provider credentials nor a Codex login. A `Saved persona does not match its manifest` error means the saved Markdown failed its integrity check. Older Windows checkouts can trigger this when Git converts LF line endings to CRLF; the same conversion can invalidate saved transcripts. `.gitattributes` preserves the exact bytes of both artifacts. Use a fresh clone containing that file, or back up local edits before restoring the affected bundled artifacts from Git with the new attributes in place. Restart the service and refresh the page. If the endpoint succeeds but the page stays on “Loading personas…”, check the browser Console and failed JavaScript requests.

```sh
npm run start:web
```

Open [debate practice](http://127.0.0.1:3000). Choose an included persona, or build a speaker persona in **Source library**. Enter a topic, choose a speaker persona and a debate model, and select **Prepare debate**. Review the two positions, then take either side to start the opponent's opening. Send arguments or questions to continue. Regenerate positions before choosing a side, retry failed generations, or end the debate at any time. Starting a new debate lets you change the topic, speaker or model. **Source library** opens the source records and persona tools. Build or update a persona from the speaker's saved sources, review its Markdown, then select **Practice with this persona**.

During generation, a visible spinner identifies the current stage and shows elapsed seconds. Replies can take up to two minutes; longer waits show additional guidance, and **End debate** cancels the request. The indicator has no percentage because the provider does not report completion progress. Provider outages, interrupted connections, and account or input limits receive distinct recovery messages.

Generated speeches and submitted human arguments are judged automatically. Each speech shows a score out of 100 and one concise comment. Expand **Score breakdown** to see separate scores and short explanations for clarity, reasoning, and engagement. The overall score is their rounded average; the expanded view explains that these criteria are provisional. The judge uses the selected practice model in a separate runtime and sees only the speech, its side, and preceding debate content. Judging adds provider requests and can take up to two additional minutes. If evaluation fails, **Retry judging** retries that speech's feedback without regenerating arguments or removing the transcript. You can continue practicing after an evaluation failure. See [speech judging](doc/judger/README.md#practice-speech-feedback) for the evaluation contract.

If a Responses-to-Chat gateway explicitly rejects resumed assistant `output_text` history, the adapter makes one fresh Codex request with the confirmed transcript supplied as debate data. Subsequent practice turns use that compatible format. The same bounded fallback supports position repair. This compatibility recovery is separate from the bounded HTTP retries; authentication and unrelated request-validation errors do not trigger a fresh-thread fallback.

On Apple Silicon, run `npm run speech:setup` once before using voice practice. `npm run start:web` builds the app, starts the speech service and its workers, waits for speech readiness, then starts the web server. It reuses an existing speech service at `SPEECH_SERVICE_URL`; Ctrl+C stops only processes started by this command. Missing runtime files, worker failures and readiness timeouts stop startup with an error. Use `npm run start:web:only` to start just the web server when speech is not needed. In an active debate, choose **Speak argument**, allow microphone access, and choose **Stop recording** when finished. Recording stops automatically after 115 seconds. The local transcription is appended to your draft; review or edit it, then choose **Send argument**. Typed input remains available if microphone access or transcription fails. Microphone access requires localhost or HTTPS and a browser with `MediaRecorder` support.

Your reviewed speech text is judged after submission using the same criteria as typed arguments. The judge assesses the words, not your voice or audio quality, and does not penalize speech disfluencies alone.

Transcription defaults to English (`LOCAL_ASR_LANGUAGE=en`). Automatic language detection can miss short English clips; set `LOCAL_ASR_LANGUAGE=auto` only when automatic detection is desired. Choose the input in **Microphone** and check the live level meter while speaking. The app shows the active microphone, recording duration, detected sound and mute warnings. If the meter stays empty, select another input and check its recording volume. Level monitoring is optional and does not block recording in browsers that cannot provide it.

If the assistant's opening or reply fails, you can still speak or type a draft. Choose **Retry opening** or **Retry assistant response** before sending it. Retrying keeps any new or edited draft and reuses the failed turn's original input.

**Read replies aloud** is enabled by default and can be turned off. Each new assistant response is spoken once, including the opening and successful retries. **Replay response** reads an earlier reply; **Stop audio** interrupts generation or playback. If the browser blocks autoplay, **Play audio** starts the prepared passage without generating it again. Long responses are read as short passages in order. Starting a recording interrupts playback, and ending or replacing a debate, leaving the debate screen, or closing the page cancels active voice work. Restoring a debate after reload does not read its existing history automatically. Speech failures do not discard the debate transcript or typed draft.

Practice and Arena share the following seven-model allowlist, in this order. Models are offered only when their exact IDs are returned by the configured endpoint's authenticated `/models` API:

| Display name | API model ID |
| --- | --- |
| DeepSeek V4.1 Flash 1017 | `deepseek-ai/DeepSeek-V4.1-Flash-1017` |
| MiniMax-M3.1-Flash | `MiniMaxAI/MiniMax-M3.1-Flash` |
| Nemotron-3.5-Lightning | `nvidia/Nemotron-3_5-Lightning` |
| Gemma-4-31B-it | `google/gemma-4-31B-it` |
| Qwen3.8-27B | `Qwen/Qwen3.8-27B` |
| Muse Spark Open | `meta-models/muse-spark-open` |
| GLM 5.3 Flash | `zai-org/GLM-5.3-Flash` |

GLM 5.3 Flash requests explicitly use `low` reasoning effort for preparation, speeches, source analysis and scoring. Its [official model card](https://huggingface.co/zai-org/GLM-5.3-Flash#note) documents `low`, `high` and `max`, with `max` as the default when omitted. Lower effort is intended to reduce waiting time; it does not guarantee a fixed response time. Other models retain their existing reasoning settings.

If `NEBIUS_MODEL` matches an available choice above, it is selected by default. Otherwise the first available choice is selected. Unavailable models are omitted, and configuring a different default does not add it to the Practice picker. Model lists are cached on the server for five minutes; **Refresh models** retries discovery after a failure. A selected model is fixed for preparation, opening arguments and every subsequent turn, including retries. Model availability in the list does not certify compatibility with the pinned Codex runtime; generation errors remain visible and no other model is used automatically. Nebius publishes its [API reference](https://api.tokenfactory.nebius.com/docs) and [current model catalog](https://tokenfactory.nebius.com/api/public/models_info). Google's [Gemma model card](https://huggingface.co/google/gemma-4-31B-it) identifies its model ID; the configured endpoint must also serve it before it can be selected.

**Socrates of Athens** is included as an authored persona and can be selected directly in Practice or Arena without uploading sources or compiling a persona. **Review persona** opens its Markdown in the library, where it can also be downloaded. The [persona index](data/README.md#authored-personas) links to its active instructions and preserved original template. This is a simulated speaking style; no historical quotations or source evidence are claimed.

A ready speaker has a saved persona Markdown file. For source-based personas, the compiler analyzes all saved, validated source records matching the speaker name and distills vocabulary and language preferences, sentence patterns, tone and register, rhetorical devices, argument structure, evidence use, rebuttal habits, and treatment of uncertainty and values. The canonical generator prompt is `PERSONA_GENERATION_PROMPT` in [`src/prompts/persona-generation.ts`](src/prompts/persona-generation.ts); edit that file to change generation requirements. It requires concise second-person `guidance`, which becomes the direct instructions in `persona.md` sent to the debate agent. Observations, confidence, supporting evidence, limitations and source provenance remain in `persona.json` for tracing. This is persona compilation for prompting, rather than model fine-tuning.

Practice loads the saved `persona.md` as the speaker context. Raw remarks, transcripts, summaries and the tracing analysis are not added to the practice prompt. The persona is copied into the session and stays fixed; adding sources or rebuilding it affects future sessions. Rebuild previously saved personas to adopt the instruction-only Markdown format. The opponent uses compatible persona details while defending its assigned side, with the [parliamentary speaking-style prompt](src/prompts/parliamentary-speaking-style.md) taking priority over conflicting style guidance. The backend loads that document's text block for openings and replies in web Practice, the CLI and Arena. It supplies speech names, word budgets (250 for openings; 180 for replies), available preparation notes and the conversation, without adding raw source excerpts. Restart the server and start a new session to use prompt edits. Generated arguments remain a labeled simulation, and the assigned side does not establish the real speaker's views.

The browser keeps the current session ID and model preference in session storage and restores server state after a reload. Debate sessions and transcripts are held in server memory, expire after one hour of inactivity, and disappear on server restart. At most 20 debates can be open at once. Ending aborts generation and disposes the isolated runtime; completed messages remain visible until another debate starts or the session expires. Credentials stay on the server. Generating positions and arguments uses the configured provider and consumes provider credits.

The JSON API supports:

| Method | Path | JSON body |
| --- | --- | --- |
| GET | `/api/models` | None; returns `models` and `defaultModel` |
| POST | `/api/debates` | `{ "speakerId": "persona-id", "model": "provider/model-id" }`; omit `model` to use the catalog's available allowed default |
| GET | `/api/debates/:id` | None |
| POST | `/api/debates/:id/prepare` | `{ "topic": "Your topic" }` |
| POST | `/api/debates/:id/choose` | `{ "side": "affirmative" }` or `{ "side": "negative" }` |
| POST | `/api/debates/:id/respond` | `{ "contribution": "Your argument" }` |
| POST | `/api/debates/:id/retry` | `{}` |
| POST | `/api/debates/:id/judge` | `{ "messageIndex": "0" }`; retry feedback for an unjudged speech by zero-based index |
| POST | `/api/debates/:id/end` | `{}` |

Successful requests return a session snapshot. Failed session actions return a sanitized `error` and the current `session` snapshot when available, preserving the pending input for retry. Topics are limited to 2,000 characters, contributions to 12,000 characters, and JSON requests to 64 KiB. The local server enforces the same loopback and origin restrictions for debate and source routes.

## Arena model comparison

Open **Arena** in the web app. Enter a topic, choose a speaker persona, and optionally change the judge model. The server randomly selects four distinct model IDs from the configured providers for each new session; at least four distinct IDs must be available. The same model ID offered by multiple providers counts as one candidate. Prepare and review the shared positions, select affirmative or negative, then run the comparison. All four models generate an independent opening for the same side, topic, positions and saved persona Markdown using Practice’s `CodexDebateAgent.opening` method. Each starts with an empty conversation history, so no candidate sees another candidate’s speech. The generated speeches remain visible alongside their scores.

Scoring runs automatically after each participant's opening, before the next participant starts, using the existing `CodexArgumentJudge` from Practice in a separate runtime with the selected judge model. Each speech receives clarity, reasoning and engagement scores from 0 to 100, short comments, and an overall score calculated as their rounded mean. The browser displays each score while the remaining participants are still running. The judge sees only the topic, positions, chosen side and target speech, with no model identities, persona instructions, other candidates or earlier scores. These scores are provisional assessments of the supplied speeches, not a general model ranking. Failed generation or invalid feedback can be retried without repeating completed speeches or successful evaluations; retrying a score then continues the remaining participants. See [the judger documentation](doc/judger/README.md) for the evaluation contract.

Arena allows up to five minutes per model request for preparation, openings and scoring. Set `ARENA_REQUEST_TIMEOUT_SECONDS` to an integer from 30 to 600 in `.env` to adjust this limit, then restart the server. This is a separate limit for each request, not the whole comparison. A timeout preserves completed speeches and scores; **Retry generation** or **Retry scoring** resumes the unfinished step. **End comparison** cancels the active request.

By default Arena uses the existing `NEBIUS_BASE_URL` and `NEBIUS_API_KEY`. To compare providers, set `ARENA_PROVIDERS` to a JSON array in `.env`, with keys stored in separate environment variables:

```dotenv
ARENA_PROVIDERS='[{"id":"nebius","name":"Nebius","baseUrl":"https://api.tokenfactory.nebius.com/v1","apiKeyEnv":"NEBIUS_API_KEY"},{"id":"other","name":"Other provider","baseUrl":"https://api.example.com/v1","apiKeyEnv":"OTHER_API_KEY","defaultModel":"model-id"}]'
OTHER_API_KEY=your-other-key
```

Each profile provides a unique `id`, display `name`, API `baseUrl`, and `apiKeyEnv` naming the server environment variable containing its key. `defaultModel` is optional. These settings are administrator configuration; the browser receives model identifiers and provider labels, without keys. Arena filters each provider's authenticated `/models` response through the same seven-model allowlist as Practice. This applies to participants and judges; models outside the list cannot be selected, including through a configured default. Unavailable choices are omitted, and a default outside the available allowlist selects the first available allowed model. Each selected endpoint still needs Codex Responses compatibility. No failed request falls back to another model or provider.

The Arena API supports:

| Method | Path | JSON body |
| --- | --- | --- |
| GET | `/api/arena/models` | None; returns public model choices and their selection keys |
| POST | `/api/arenas` | `{ "speakerId": "persona-id", "judgeModel": "provider:judge-model-id" }`; `judgeModel` is optional and defaults to the catalog default |
| GET | `/api/arenas/:id` | None |
| POST | `/api/arenas/:id/prepare` | `{ "topic": "Your topic" }` |
| POST | `/api/arenas/:id/run` | `{ "side": "affirmative" }` or `{ "side": "negative" }`; generates and automatically scores all four speeches |
| POST | `/api/arenas/:id/judge` | `{}`; evaluates unscored speeches when judging is available |
| POST | `/api/arenas/:id/retry` | `{}` |
| POST | `/api/arenas/:id/end` | `{}` |

Use the exact selection `key` returned by `/api/arena/models` for an explicit `judgeModel`. Participant selection happens on the server and is fixed for that session; start a new comparison to draw again. Failed actions return a sanitized error and session snapshot when available. Retry preserves generated speeches and successful scores, and ending cancels further generation and judging while ignoring late results. Arena sessions are held in memory, expire after one hour of inactivity, and disappear on server restart. Generation and judging consume credits at the selected providers.

## Video records

Run the frontend and backend locally:

```sh
npm run start:web
```

Open [the web app](http://127.0.0.1:3000) and select **Source library**. Enter a speaker name. In **Video**, choose **Paste link** or **Upload file**. In **Transcript**, choose **Paste text** or **Upload file**. The title is optional. The interface shows saved records, summaries linked to supporting remarks, original transcripts, structured JSON and uploaded-video playback. Set `PORT` to change the local port.

The backend uses the Codex SDK with the same provider configuration as the debate CLI. Provider credentials stay on the server. Browsing saved records does not require provider credentials; generating a record requires the `.env` settings above and consumes provider credits. The transcript supplies the words; video uploads are retained as source material and are not automatically transcribed or sent to the model.

After reviewing the source, build or update the speaker persona. Sources with the same normalized speaker name are analyzed together. The generated persona is saved under `data/persona-<uuid>/` as `persona.md` with `persona.json` metadata. Existing sources remain available for review; they do not become practice opponents until a persona is compiled. The persona can be inspected and downloaded from the library.

On Apple Silicon, [speech](doc/local-speech.md) uses SGLang-Omni's native MLX server for transcription and supports local Voxtral or ElevenLabs voices. In **Transcript → Paste text**, expand **Transcribe an audio file locally**, choose a clip and review the resulting transcript before generating a record. To hear an excerpt, select up to 600 characters in a saved record and choose **Read selected text aloud**. Run `npm run speech:setup` once; `npm run start:web` then starts speech with the web app. Record analysis still uses its independently configured provider.

Choose the voice backend in `.env`: `TTS_PROVIDER=local` is the default and requires no speech API key. To use ElevenLabs, set `TTS_PROVIDER=elevenlabs` and `ELEVENLABS_API_KEY`. Optional overrides are `ELEVENLABS_VOICE_ID` (default `JBFqnCBsd6RMkjVDRZzb` when blank or unset) and `ELEVENLABS_MODEL_ID` (default `eleven_multilingual_v2`). Restart the speech service after changes. ElevenLabs mode sends synthesis text to ElevenLabs, keeps transcription local and does not launch the local TTS worker. See [voice provider setup](doc/local-speech.md#switch-voice-providers).

Use the **Voice** selector in Debate practice to choose the spoken voice. In ElevenLabs mode, Andy Burnham defaults to **The Rising Reformer** (`6osMNatXqZrKCuGTB2bV`), a fictional politician-style voice rather than a clone of Andy. You can switch to the configured default voice; the browser remembers your choice for each speaker name, including after a persona rebuild. Local mode offers the configured local voice.

Speech runs as an independent microservice at `http://127.0.0.1:8764`, with a `/health` readiness check. The app proxies its existing speech routes to that service. Other browser frontends can call it directly using an explicit `SPEECH_ALLOWED_ORIGINS` allowlist; see the [frontend API examples](doc/local-speech.md#api-and-validation). `npm run speech:serve` starts the API alone when model workers already run separately.

Each record is checked against the [strict versioned JSON Schema](schema/video-record.schema.json). Extracted quotes must occur verbatim in source cues, in order, and summary references must point to existing remarks. Speaker attribution and summaries still require human review. The [video data index](data/README.md) describes the saved folder format; [the service documentation](doc/video-record-service.md) covers the API, validation and limits.

## Design documents

- [Product intent](doc/intent.md)
- [Behavior specification](doc/spec.md)
- [Technology stack](doc/tech-stack.md)
- [Video-record service and API](doc/video-record-service.md)
- [Speech with local or ElevenLabs voices](doc/local-speech.md)
- [Judger documentation](doc/judger/README.md)

Complete competition formats, final judging criteria, continuous full-duplex conversation, and browsing archived debates remain in the backlog.
