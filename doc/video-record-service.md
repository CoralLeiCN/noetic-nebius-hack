# Source records and speaker personas

## Workflow

Run `npm run start:web` and open `http://127.0.0.1:3000`. The frontend and API are served by the same local Node.js backend. The debate-practice CLI remains available through `npm start`.

Provide a speaker name, a transcript, and a video source. The **Video** section switches between pasted links and file upload; multiple links can be entered on separate lines. The **Transcript** section switches between pasted text and file upload. Switching methods retains each draft but submits only the active input. The title is optional. The service retains uploaded video for playback and reference; it does not perform speech recognition, download video links or verify captions against audio. A transcript is required for every submission.

The backend normalizes either transcript input to bytes, parses transcript cues, asks the Codex SDK to identify the speaker's words and summarize them, validates the result, and publishes the files together under `data/video-<uuid>/`. Uploaded transcript bytes are preserved, including original line endings. Pasted text is stored as UTF-8 exactly as received in the multipart request; browsers may normalize textarea line endings during submission. Both methods produce the same version 1.0 record format. Generation failures do not publish a record. Startup after an interrupted process may leave an ignored `.pending-*` directory; these directories are never listed as records.

The source library supports record selection, summaries with links to supporting remarks, speaker remarks with original timestamps, full-transcript inspection, structured JSON downloads, and playback of uploaded video. Clicking a timestamp seeks an uploaded video. Untimed source text is marked as untimed.

## Speaker persona compilation

Source records are training material for a reusable speaker persona. They are not passed directly into practice. After reviewing a source record, build or update the speaker persona in the library. All validated records matching the same normalized speaker name contribute to the compilation. Consistent naming groups a speaker's sources; different people must use distinct names.

The compiler uses the official Codex SDK and the existing ChatGPT OAuth login associated with `CODEX_HOME` (default `~/.codex`). Sign in with `codex -c 'cli_auth_credentials_store="file"' login` before building a persona. The compiler requires a file-backed OAuth login; an API-key or keyring-only login is not used. `CODEX_PERSONA_MODEL` optionally selects the compiler model; otherwise Codex uses its default. Persona compilation does not use the Nebius credentials or fall back to the source-extraction provider. It uses isolated task configuration and history, with tools disabled. See [Codex authentication](https://learn.chatgpt.com/docs/auth).

The persona covers these dimensions:

| Dimension | Practice behavior |
| --- | --- |
| Language and vocabulary | Preferred words, expressions, register and use of technical or everyday language. |
| Sentence structure and rhythm | Sentence length, repetition, transitions and phrasing patterns observable in text. |
| Tone and register | Formality, directness, warmth, intensity and audience adaptation. |
| Rhetorical devices | Questions, analogies, contrasts, stories and emphasis. |
| Argument structure | How claims, explanations, examples and conclusions are connected. |
| Use of evidence and examples | Treatment of statistics, testimony, lived experience and source attribution. |
| Interaction and rebuttal | Responses to challenges, concessions, reframing and questions. |
| Uncertainty and expressed values | Qualification, confidence, recurring priorities and limits of the available evidence. |

Each dimension records an observation, guidance for practice, confidence (`high`, `medium`, `low` or `unknown`) and supporting evidence. Evidence quotes are checked against saved remarks; the Markdown carries source references rather than raw source passages. Insufficient evidence stays explicit. Transcript-derived observations do not establish acoustic voice characteristics or justify invented beliefs. The saved Markdown describes a simulation and keeps new debate arguments separate from the person's actual statements.

Persona analysis accepts at most 120,000 serialized characters of source input. Larger inputs fail explicitly without truncation. Compiled Markdown is limited to 48,000 characters; an oversized result is rejected without publication. Only one persona compilation runs at a time; another build request returns 429.

Compilation saves `persona.md` and `persona.json` under `data/persona-<uuid>/`. The library lets the human inspect and download the Markdown. Compilation supplies prompt context rather than fine-tuning model weights. Updating source material does not update a persona automatically: rebuild the persona and start a new debate to use the new version.

Practice reads only the saved persona Markdown as speaker context, identified by `personaId`. Source remarks, transcripts and summaries stay in the library. The current debate keeps its copied persona even if another version is compiled.

## Codex integration

`CodexVideoAnalyzer` uses the official `@openai/codex-sdk`, pinned to the repository's existing version, and the provider settings `NEBIUS_BASE_URL`, `NEBIUS_API_KEY` and `NEBIUS_MODEL`. It shares the existing isolated runtime configuration: a private temporary Codex home, replacement task instructions, read-only sandbox, disabled tools and integrations, no approval prompts and no provider fallback. Each generation gets a fresh thread and removes its temporary runtime afterward.

The SDK's `outputSchema` constrains generated analysis. The application independently validates that output with Ajv, checks quote spans and references, and constructs the final record itself. The model does not choose storage paths, source URLs, filenames, hashes, record IDs or timestamps. Invalid output is rejected without a repair retry. An empty extraction reports that no speaker remarks were identified.

The schema used during generation permits empty remark and summary arrays to report no match. The persisted-record schema requires both arrays to be nonempty.

For source extraction, only the speaker name and parsed transcript cues are sent to the configured model provider for inference. The video binary, source URLs and title remain in local storage. SDK history may contain transcript data while a request is running; temporary history is removed on normal disposal. Browsing records does not invoke the model. The local UI does not need provider credentials until source generation is requested. Persona compilation separately sends the saved speaker material to Codex through the OAuth login.

## Strict schema and validation

The canonical contract is [video-record.schema.json](../schema/video-record.schema.json), also served at `GET /api/schema`. It uses JSON Schema draft 7, version `1.0`, with all record fields required and unknown fields rejected at every object level. Optional uploaded-video metadata is explicitly `null` when absent. Untimed cues have `startSeconds: null`; other times are whole seconds from the source captions. Subtitle fractional seconds are truncated to whole seconds when cues are parsed.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Exact contract version, currently `1.0`. |
| `id` | Safe record identifier matching its folder name. |
| `title`, `speakerName`, `createdAt` | Record metadata; creation time is generated by the service in UTC. |
| `sources` | One to 20 HTTP/HTTPS source references or a reference to the locally uploaded video. |
| `video` | Uploaded filename, original name, MIME type, byte size and SHA-256, or `null`. |
| `transcript` | Original transcript filename and SHA-256, user-supplied provenance, `audioVerified: false`, and numbered parsed cues. |
| `analysis.remarks` | Ordered exact quote spans, each pointing to a source cue and carrying uncertainty and note fields. |
| `analysis.summary` | English summaries with titles and zero-based indexes of supporting remarks. |
| `analysis.limitations` | Caption gaps, attribution issues and other source limitations. |

Additional application checks enforce sequential cue IDs, chronological timestamps, safe source URL schemes, matching upload references, verbatim contiguous quote spans, no quote overlap or reordering, notes for uncertain remarks, and valid summary references. Full-record reads verify the transcript's hash and parsed cues against its saved bytes. Quotes can be source-exact even when the captions contain recognition errors; quote matching does not establish correct speaker attribution or factual truth.

New records contain `README.md`, `record.json`, `transcript.txt`, `speaker-remarks.md` and `summary.md`, plus an optional video file. Markdown is rendered deterministically from the validated record. The existing Andy Burnham record was imported into this schema while preserving its original transcript and reviewed Markdown notes.

## API

| Method | Route | Result |
| --- | --- | --- |
| `GET` | `/api/schema` | Full persisted-record JSON Schema. |
| `GET` | `/api/videos` | Saved record IDs, titles, speaker names and creation dates, newest first. |
| `POST` | `/api/videos` | Generate and save a record; returns HTTP 201 and the full record. |
| `GET` | `/api/videos/:id` | Validated structured record. |
| `GET` | `/api/videos/:id/files/:name` | Allowlisted artifact, including byte-range requests for video playback. |
| `GET` | `/api/personas` | Latest compiled persona per normalized speaker name: ID, name, creation date and source count. |
| `POST` | `/api/personas` | Compile all sources for `{ "speakerName": "Name" }`; return the saved persona. |
| `GET` | `/api/personas/:id` | Saved persona metadata and Markdown. |
| `GET` | `/api/personas/:id/files/persona.md` | Download the persona Markdown used by practice. |

`POST /api/videos` accepts only multipart form data with these fields:

| Field | Required | Format |
| --- | --- | --- |
| `speakerName` | Yes | Nonempty text, at most 120 characters. |
| `transcript` | If no pasted text | UTF-8 TXT, SRT, VTT or pasted-YouTube text in an uploaded file. |
| `transcriptText` | If no transcript file | Pasted original transcript text, encoded as UTF-8 by the service. |
| `title` | No | At most 300 characters; defaults to the uploaded video name or a title based on the speaker. |
| `sourceUrls` | If no video | HTTP/HTTPS links separated by newlines; links are recorded without being fetched. |
| `video` | If no source URL | MP4, WebM or MOV file with matching MIME type and a recognized container header. |

Unknown or duplicate multipart fields are rejected. Exactly one nonempty transcript input must be supplied: `transcript` or `transcriptText`. Providing both is rejected rather than silently choosing one. Requests support at most 20 combined source URLs and uploaded-video references. Video size is capped at 100 MiB, transcript size at 1 MiB and 500,000 characters, and total multipart body size at 102 MiB. At most 10,000 cues are accepted, with at most 100,000 characters per cue. The model's context limit may impose a lower practical transcript limit; provider rejections leave no saved record.

Errors return `{ "error": "application-owned message" }`. Validation failures use 400/413/415, no identified speaker uses 422, concurrent generation uses 429, and invalid model output or provider failures use 502. No partial response or provider response body is exposed. Cancellation aborts the SDK turn; if cancellation arrives after publication, the completed record remains available in the library.

## Local operation and verification

The server binds to `127.0.0.1` and accepts local Host headers and same-origin browser requests. It is intended for local use and has no multiuser authentication. Only one source upload/generation is admitted at a time; other requests to generate return 429, while saved records remain readable. Credentials are never returned to the frontend. Filenames and IDs are constrained, artifacts are allowlisted, and symlinks are rejected at record and artifact boundaries. The browser renders source and generated text as text rather than HTML.

Uploaded videos and temporary publication folders are ignored by Git. Structured records, transcripts and Markdown remain ordinary repository data. Back up any locally retained video files separately if needed.

Run `npm run typecheck` and `npm test`. The tests cover source parsing, strict schema rejection, quote fidelity, source hash verification, atomic publication, invalid uploads, byte-range delivery, origin restrictions, concurrency, and a full multipart upload through the real Codex SDK and runtime against a local Responses fixture. The fixture tests use no provider credits. Live source-extraction quality depends on the configured provider. Live persona quality and model access depend on the Codex OAuth account. Review both with actual user material; local fixture tests do not verify live OAuth inference.
