# Source records and speaker personas

Store each video's source references, transcript and summarized remarks together in a separate folder under `data/`.

The service creates folders named `video-<uuid>`. Imported records may use the platform and video ID, such as `youtube-xX9c2Vg2Z00`. Record IDs must match their folder names.

## Folder structure

```text
data/
  README.md
  <platform>-<video-id>/
    README.md
    transcript.txt
    record.json
    speaker-remarks.md
    summary.md
    judger-score.md
    video.mp4             # Optional; may instead be video.webm or video.mov
```

| File | Contents |
| --- | --- |
| `README.md` | Video title, links to all source videos used, links to the transcript and remarks, and provenance or accuracy notes. |
| `transcript.txt` | Complete supplied transcript, preserved without edits. |
| `record.json` | Authoritative structured record conforming to [schema version 1.0](../schema/video-record.schema.json), including the speaker, source references, parsed cues, exact quote spans and summaries with evidence references. |
| `speaker-remarks.md` | Timestamped extraction of the named speaker's remarks, with uncertain speaker boundaries and caption gaps marked. |
| `summary.md` | Timestamped summary of the relevant remarks, with source links and any limitations. |
| `judger-score.md` | Evidence-based style assessment against the supplied debate-style dimensions, with unavailable dimensions and transcript limits identified. |
| `video.mp4`, `video.webm` or `video.mov` | Optional uploaded source video. Video binaries are kept locally and ignored by Git. |

Use `npm run start:web` to upload and process new records through the Codex SDK service. The frontend and `GET /api/videos` discover saved structured records automatically. The table below lists the original imported record. Distinguish supplied captions from audio-verified transcription and distinguish quoted words from summaries. Do not reconstruct missing speech.

## Video index

| Video | Source | Records |
| --- | --- | --- |
| Andy Burnham and Kemi Badenoch face off in first ever PMQs clash | [YouTube / PoliticsJOE](https://www.youtube.com/watch?v=xX9c2Vg2Z00) | [Video record](youtube-xX9c2Vg2Z00/README.md) |

## Compiled speaker personas

Use **Build speaker persona** in the source library after reviewing a speaker's records. The Codex SDK uses the existing ChatGPT OAuth login to analyze all source records with the same normalized speaker name. Each compiled version is saved in its own folder:

```text
data/
  persona-<uuid>/
    persona.md
    persona.json
```

`persona.md` describes observed language, vocabulary, sentence rhythm, register, rhetoric, argument structure, evidence use, rebuttal habits and uncertainty, with confidence, limitations and evidence references. `persona.json` preserves compilation metadata, source fingerprints, validated supporting quotes and the Markdown checksum. Practice reads the saved Markdown as its speaker context; original transcripts, remarks and summaries remain training material in the library. Rebuild after adding sources, then start a new debate to use the updated persona. Previous versions remain available to existing sessions.

| Speaker | Compiled persona | Training sources |
| --- | --- | --- |
| Andy Burnham | [Persona Markdown](persona-b69edf22-13f3-4ae8-b3a5-63462f0cd8f2/persona.md) | [Parliamentary exchange](youtube-xX9c2Vg2Z00/README.md) |

The Andy Burnham persona was compiled through a live Codex OAuth request on October 24, 2026. It reflects one captioned exchange; its observations are scoped to that source.
