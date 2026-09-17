# n8n-nodes-blurwerk

An [n8n](https://n8n.io) node for [blurwerk](https://blurwerk.de/?ref=n8n):
anonymize video inside a workflow. Every face in every frame is mosaiced,
voices can be disguised or muted, and location metadata is removed. You get the
same file back in the same format. Processing happens on blurwerk's own
hardware in Germany; the video is never sent to a third-party AI service.

## Install

In n8n: **Settings → Community Nodes → Install**, and enter
`n8n-nodes-blurwerk`.

## Credentials

blurwerk sells prepaid credit in whole units of €5. Buy it once at
[blurwerk.de/credit](https://blurwerk.de/credit?ref=n8n). The page shows an API
token (`bw_…`) **once**. Paste it into a new **blurwerk API** credential.

## Operations

| Operation | What it does |
|---|---|
| **Anonymize Video** | Takes a video from a binary field and prices it from its own header, read locally (nothing is uploaded to get a price). Then it pays with credit, uploads the file and, by default, waits and outputs the anonymized video as binary data. |
| **Get Result** | Returns the state of an order and, once it is done, the video. Use it after an **Anonymize Video** run that did not wait. |
| **Get Balance** | Returns the remaining credit. |
| **Report Problem** | Reports that a delivered result is not usable. It is refunded, and the result is deleted. |

**Anonymize Video** requires two declarations, both mandatory: that work may
start at once (§ 356(4) BGB, which ends the 14-day withdrawal right), and that
the result will be checked before it is published.

**Options:**
- **Audio:** keep, disguise the voice, or mute.
- **Sensitivity:** how sure the detectors must be before a face is covered.
- **Mosaic size**
- **E-mail:** an address to send the download link to.
- **Language**

**File Details** are only needed if the node can't read the file's header
(MP4, MOV, MKV, WebM, AVI, TS/M2TS, MPEG-PS and FLV all work). blurwerk
measures the file again when it arrives. If it turns out cheaper, you're
charged the lower price; if it turns out dearer, the order is refused and
refunded.

## Timing

Processing takes about twice the video's length at 1080p and about eleven
times at 4K, because every frame is checked at full resolution. For long
videos, or on n8n Cloud plans with short execution limits, turn off **Wait for
Result**. Then fetch the video later with **Get Result**, for example on a
schedule.

## Privacy

- The filename never leaves your n8n instance; only the extension is sent.
- blurwerk deletes the uploaded copy as soon as the job finishes, and deletes
  the result when its download link expires.
- See [blurwerk.de/datenschutz](https://blurwerk.de/datenschutz).

## Development

```sh
npm install --ignore-scripts   # n8n-workflow's native optional deps are not needed
npm test                       # builds, runs n8n's linter, then a whole order against a fake server
```

The header parser in `nodes/Blurwerk/vendor/` is the one blurwerk.de runs in
the browser, copied in unchanged, so a file gets the same price here as on the
website.

Releases are published by `.github/workflows/publish.yml` when a version tag
is pushed, with npm provenance. `npm publish` from anywhere else is refused.

## License

MIT
