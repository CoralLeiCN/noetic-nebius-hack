# Local speech on Apple Silicon

Transcription and speech synthesis run as an independent local microservice backed by SGLang-Omni's native C++ MLX servers. This is the separate `sglang_omni_mlx/native` path, not the CUDA wheel or the PyTorch/MPS installer. The existing debate and record-analysis model remains independently configured.

```text
Frontend → app's same-origin speech proxy → speech API :8764 → ASR worker :8765
                                                           → TTS worker :8766
Other allowed browser frontend ───────────→ speech API :8764
CLI ─────────────────────────────────────→ speech API :8764
```

The speech API is its own Node process. It owns audio conversion, limits, cancellation and shared admission across clients. The app and CLI use HTTP to call it; they do not load MLX models. It can run while the debate app is stopped.

## Models and reproducibility

The implementation was checked against SGLang-Omni commit `6e75cba89c598b41bcadf8d6a761c09e9979ad20` on 24 October 2026. Setup pins that source revision and uses its per-file SHA-256 model manifests; it does not track a moving main branch. Native builds use the upstream pinned MLX 0.32.3 wheel. Build tools, source, model weights and measurements stay under ignored `.speech/`.

| Purpose | Checkpoint | Selection |
| --- | --- | --- |
| Default transcription | `mlx-community/nemotron-3.5-asr-streaming-0.6b-8bit` | Small cache-aware ASR model; native runtime also provides a realtime socket. |
| Alternative transcription | `mlx-community/Qwen3-ASR-1.7B-6bit` | Compare on representative recordings, especially names and multilingual speech. |
| Speech generation | `mlx-community/Voxtral-4B-TTS-2603-mlx-4bit` | Native MLX TTS with named voices; 4-bit weights limit memory use. |

Qwen3-TTS support in the CUDA runtime does not establish support in the native MLX runtime. This revision has a native Voxtral TTS server, so the app uses Voxtral rather than pointing a CUDA Qwen3-TTS config at a Mac.

Voxtral's model card marks its weights **CC BY-NC 4.0 (noncommercial)**. Nemotron uses the NVIDIA Open Model License. SGLang-Omni's runtime license and model-weight licenses are separate. See the [Voxtral checkpoint](https://huggingface.co/mlx-community/Voxtral-4B-TTS-2603-mlx-4bit) and [Nemotron checkpoint](https://huggingface.co/mlx-community/nemotron-3.5-asr-streaming-0.6b-8bit).

## Setup and use

Requirements: an Apple Silicon Mac, Xcode, `uv`, `git`, `ffmpeg` and Python 3.9 or newer for the launcher. The upstream build creates a separate Python 3.12 environment for its build tools. Its default macOS deployment target is 15.0. Setup downloads several gigabytes of weights; the comparison model is optional.

```sh
npm run speech:setup
npm run speech:start
```

Keep `speech:start` running in a separate terminal. It starts the speech API on `127.0.0.1:8764`, ASR on `127.0.0.1:8765` and TTS on `127.0.0.1:8766`. It stops all three child processes on exit or a child failure. The launcher selects matching checkpoint IDs for the API and workers, including when `--asr qwen` is supplied. Models remain loaded between requests. No cloud inference, fallback or API key is used for speech.

`GET http://127.0.0.1:8764/health` returns HTTP 200 and `ready: true` only when both workers advertise the configured model IDs. Otherwise it returns HTTP 503, `ready: false` and per-model readiness. If the MLX workers are already running, start just the API with `npm run speech:serve`.

Start the web app with `npm run start:web`. In the pasted-transcript panel, choose **Transcribe an audio file locally** and review the draft. This does not save a record or invoke record analysis. Only the reviewed text is submitted when you generate a record; record provenance continues to describe a user-supplied, unverified transcript. Audio uploaded to this transcription route is not saved. Recognition does not identify a named speaker or independently verify the transcript.

Select an excerpt in a saved record and choose **Read selected text aloud**. The source-library player waits for a complete WAV.

The debate frontend also uses this service for microphone arguments and spoken assistant replies. **Speak argument** obtains microphone access only when clicked. **Stop recording** submits the complete browser recording to the same-origin transcription proxy; the transcript is appended to the existing draft for review and is not sent as a debate argument until **Send argument** is chosen. Recording stops at 115 seconds or the 16 MiB size limit. Tracks are released after recording, cancellation or errors, including a microphone permission prompt that resolves after cancellation. Browser-supported WebM/Opus is preferred, with MP4 and browser-default fallbacks; FFmpeg handles conversion.

Transcription defaults to an explicit English prompt (`LOCAL_ASR_LANGUAGE=en`). The Nemotron checkpoint's automatic language prompt returned an empty transcript for a bundled short British English clip during validation; the English prompt recognized the same audio as “power of nature.” Set `LOCAL_ASR_LANGUAGE=auto` to omit the prompt for automatic detection, or use a language code supported by the selected model, such as `en-GB`. This setting applies to microphone arguments and audio-file transcription. It cannot recover audio that the microphone did not capture.

A failed assistant opening or reply keeps recording and drafting available. **Retry opening** or **Retry assistant response** must succeed before the draft can be sent. Retrying preserves a new or edited draft while reusing the original pending input, so the failed turn cannot submit the next argument accidentally.

**Read replies aloud** speaks newly accepted assistant messages once, while **Replay response** reads a chosen earlier message. Reloaded history and unrelated UI refreshes do not trigger playback. Replies are split at sentence or word boundaries into passages of at most 300 characters and synthesized and played sequentially; only one passage is requested at a time. The audio element is reused, and an autoplay block retains the prepared passage for an explicit **Play audio** click. **Stop audio**, microphone activation, a new turn, End, New debate, screen navigation and page exit abort applicable generation/playback and release object URLs. Microphone capture and transcription additionally lock draft submission until finished or canceled. Drafts and confirmed conversation text survive speech errors.

Each passage is a complete WAV; this is turn-based recording and playback rather than continuous microphone capture or native PCM streaming. Native PCM streaming and the ASR realtime socket remain available upstream but are not wired to the frontend.

The command line also supports both operations:

```sh
npm run speech -- transcribe /path/to/argument.m4a
npm run speech -- speak "A strong argument needs clear evidence." /path/to/new-speech.wav
```

The speech command refuses to overwrite an existing output file. `SPEECH_SERVICE_URL` selects the API origin for the app and CLI; its default is `http://127.0.0.1:8764`. `SPEECH_PORT` changes the API listen port; update the client URL with it. Both the API and workers bind to loopback. `LOCAL_ASR_URL`, `LOCAL_ASR_MODEL`, `LOCAL_ASR_LANGUAGE`, `LOCAL_TTS_URL`, `LOCAL_TTS_MODEL` and `LOCAL_TTS_VOICE` configure the API's worker connections and language prompt when using `speech:serve`; URLs must be loopback HTTP origins. The combined launcher supplies its fixed worker URLs and matching models. Default TTS voice: `neutral_female`.

To use the Qwen alternative, download it and switch the worker and client together:

```sh
npm run speech:setup -- --compare
npm run speech:start -- --asr qwen
```

The combined launcher configures the API for Qwen automatically; the frontend and CLI keep the same service URL. When starting the API separately with `speech:serve`, set `LOCAL_ASR_MODEL=mlx-community/Qwen3-ASR-1.7B-6bit` in `.env` to match a Qwen worker. The benchmark selects its model directly and does not read `.env`.

## M4 Pro limits and measurements

The speech microservice admits one operation at a time across transcription and synthesis to limit contention across app, CLI and browser clients. Audio is capped at 16 MiB and 120 seconds, converted with local FFmpeg to 16 kHz mono PCM. Overlong clips are rejected instead of silently cut. FFmpeg cannot access network or local-file protocols through the supplied input. Speech text is capped at 600 characters, generation at 750 audio frames (about 60 seconds), and inference requests at 120 seconds. Incomplete WAV generation is rejected. Cancellation propagates through the app proxy to the service and native worker, and terminates active FFmpeg decoding. Direct requests to the native worker ports bypass the microservice's shared admission limit.

Measure with a representative recording before changing the model or limits:

```sh
npm run speech:benchmark -- --audio /path/to/representative-recording.wav
npm run speech:benchmark -- --asr qwen --audio /path/to/representative-recording.wav
```

The benchmark uses at most the first 120 seconds of the recording. It measures ASR three times in one process, separating first inference from warm repeats. TTS reports time to first generated audio, total generation time, generated audio duration and real-time factor (generation seconds / audio seconds; lower is faster). Each model runs separately under `/usr/bin/time -l`; the saved report includes peak resident memory, process notes, chip, memory capacity and source revision. It writes `.speech/benchmark-<asr>.json` and `.speech/benchmark-speech.wav`. It does not measure simultaneous workloads, browser playback latency or word error rate.

Measured on this **M4 Pro with 48 GiB unified memory**, using the pinned repository's 4.62-second English question and a separate seeded English TTS passage:

| Model | First inference in process | Warm inference | Peak process footprint |
| --- | --- | --- | --- |
| Nemotron 3.5 ASR 0.6B, 8-bit | 0.126 s | 0.104 / 0.105 s | 0.96 GB |
| Qwen3-ASR 1.7B, 6-bit | 1.071 s | 0.172 / 0.171 s | 3.44 GB |
| Voxtral 4B TTS, 4-bit | 4.442 s to generate 10.64 s audio | Not measured in the same process | 3.72 GB |

Both ASR models returned the expected question on all three runs. Voxtral's first generated audio arrived at 0.879 s and its real-time factor was 0.417, about 2.4 times playback speed. A second process produced the same seeded audio in 4.474 s, with first audio at 0.884 s. The OS and Metal kernel caches may already have been warm; an earlier first-ever Nemotron invocation took 1.22 s, so process startup numbers are not a guarantee of a cold installation's latency. The short-clip result supports the small Nemotron default, but does not establish accuracy on long debates, accents, names or overlapping speakers.

The real web API transcribed the question in 0.676 s including conversion and HTTP overhead. A short TTS request returned 3.52 s of WAV in 1.818 s, and Nemotron transcribed that generated speech back to the supplied sentence. This verifies the app path; it is not a listening-quality evaluation. Exact measurements and limitations are saved in [the benchmark record](local-speech-benchmark.json).

## API and validation

| Route | Request | Response |
| --- | --- | --- |
| `POST /api/speech/transcriptions` | Raw audio body, up to 16 MiB | JSON `{text, model}` |
| `POST /api/speech/audio` | JSON `{input: "Text to speak"}` | Complete `audio/wav` |

These routes are available on the standalone API at port 8764 and through the app's same-origin proxy. Both abort work on disconnect and return sanitized errors. Model and voice selection is server configuration, not request input. Backend redirects are rejected. Tests exercise normalization, malformed/long clips, cancellation, concurrency, incomplete generation, redirects, browser preflight, readiness, the app-to-service proxy and JSON validation. Browser-controller tests use deterministic microphone/audio doubles to verify final recorder chunks, permission failures, late results, capture limits, full reply chunking, playback order, manual autoplay recovery and resource cleanup without accessing a physical microphone.

For a separate frontend, set `SPEECH_ALLOWED_ORIGINS` to a comma-separated list of exact browser origins, then restart the API. The defaults permit `http://127.0.0.1:3000`, `http://localhost:3000`, and the corresponding origins on port 3011. For example, use `SPEECH_ALLOWED_ORIGINS=http://localhost:5173` for a Vite frontend. Wildcard origins and cookie credentials are not enabled. The app's own proxy retains its same-origin checks, so its existing frontend needs no CORS configuration.

```js
const speechUrl = "http://127.0.0.1:8764";
const controller = new AbortController();
const response = await fetch(`${speechUrl}/api/speech/transcriptions`, {
  method: "POST",
  body: audioFile, // A File or Blob, sent as the raw request body.
  signal: controller.signal,
});
if (!response.ok) throw new Error((await response.json()).error);
const { text } = await response.json();

const spoken = await fetch(`${speechUrl}/api/speech/audio`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ input: text }), // Up to 600 characters.
  signal: controller.signal,
});
if (!spoken.ok) throw new Error((await spoken.json()).error);
const audioUrl = URL.createObjectURL(await spoken.blob());
// Set an <audio controls> element's src to audioUrl; revoke the URL when done.
```

Sources: [MLX runtime separation](https://sgl-project.github.io/sglang-omni/mlx/index.html), [native runtime integration](https://github.com/sgl-project/sglang-omni/blob/6e75cba89c598b41bcadf8d6a761c09e9979ad20/Voxt/backend/README.md), [native Voxtral implementation](https://github.com/sgl-project/sglang-omni/blob/6e75cba89c598b41bcadf8d6a761c09e9979ad20/sglang_omni_mlx/native/src/voxtral_tts/voxtral_tts_server.cpp).
