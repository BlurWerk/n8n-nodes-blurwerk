# Example workflows

Two ready-made n8n workflows using the blurwerk node. In n8n, open a new
workflow, choose **… → Import from File**, and pick one of these files. Each
opens with a note that explains it and lists its setup steps.

| File | What it does | Needs |
|---|---|---|
| [`drive-folder-anonymize.json`](drive-folder-anonymize.json) | Every video added to a Google Drive folder is anonymized and saved into a second folder, under the same name with `_anonymized` added. | A Google Drive credential, two folders |
| [`web-form-anonymize.json`](web-form-anonymize.json) | Publishes a web form. Whoever uploads a video waits on the page, and their browser then downloads the anonymized file. | Nothing besides blurwerk |

Both need a **blurwerk API** credential with a prepaid token from
[blurwerk.de/credit](https://blurwerk.de/credit?ref=n8n-template). In
**Anonymize video**, read and tick both declarations before activating. The
node refuses to order without them.

What happens when a job fails: the Drive workflow stops with the reason, so the
failure shows in n8n's execution list. The form tells the visitor and gives
them a reference. A failed job is not charged. A job still running when the
wait ends is paid for; fetch its result later with the node's **Get Result**
operation.

Files travel as separate binary data (`binaryMode: separate` in the workflow
settings), which both workflows rely on.
