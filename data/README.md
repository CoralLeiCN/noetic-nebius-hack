# Video records

Store each video's source references, transcript and summarized remarks together in a separate folder under `data/`.

Use a stable folder name based on the platform and video ID, such as `youtube-xX9c2Vg2Z00`.

## Folder structure

```text
data/
  README.md
  <platform>-<video-id>/
    README.md
    transcript.txt
    <speaker>-remarks.md
    summary.md
```

| File | Contents |
| --- | --- |
| `README.md` | Video title, links to all source videos used, links to the transcript and remarks, and provenance or accuracy notes. |
| `transcript.txt` | Complete supplied transcript, preserved without edits. |
| `<speaker>-remarks.md` | Timestamped extraction of the relevant speaker's remarks, with uncertain speaker boundaries and caption gaps marked. Add a file for each speaker being recorded. |
| `summary.md` | Timestamped summary of the relevant remarks, with source links and any limitations. |

For each new video, add its folder to the index below. Distinguish supplied captions from audio-verified transcription and distinguish quoted words from summaries. Do not reconstruct missing speech.

## Video index

| Video | Source | Records |
| --- | --- | --- |
| Andy Burnham and Kemi Badenoch face off in first ever PMQs clash | [YouTube / PoliticsJOE](https://www.youtube.com/watch?v=xX9c2Vg2Z00) | [Video record](youtube-xX9c2Vg2Z00/README.md) |
