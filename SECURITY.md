# Data flow and security

The claim: **the draft, the references found in it, a document checked for
anonymization, its anonymized copy and all results never leave the
workstation.** This page says what that rests on and how to check it without
trusting us.

## What crosses the network

| Request | To | Contains | When |
|---|---|---|---|
| The add-in's files (HTML, CSS, JS, icons) | the host in the manifest: your intranet server, or ours | nothing about the document | when the pane opens |
| `index/index.json` (a few KB) | the same host | nothing about the document | pane opens; "Liste aktualisieren"; at the start of every check |
| `index/cite-index-<date>.tsv.gz` | the same host | nothing about the document | only when `index.json` names a list the pane does not have |
| `data/vocabulary.json` (under 1 KB) | the same host | nothing about the document | at the first anonymization check after the pane opens |
| `data/vocabulary-<date>-<hash>.txt.gz` (about 2 MB) | the same host | nothing about the document | only when `vocabulary.json` names a word list the pane does not have |
| `office.js` | `appsforoffice.microsoft.com` | nothing about the document | when the pane opens; Microsoft requires every Office add-in to load it from there |

That is the complete list of what the add-in requests. The cite check never
loads the word list and the anonymization check never loads the cite list. Separately, a finding offers
a link to the decision on opencaselaw.ch. Nothing is requested unless the user
clicks it; the click opens that one page in the user's browser, without a
referrer, and opencaselaw.ch then sees that this address was opened (as for any
visitor), not the draft and not the other references.

There is no telemetry, no error reporting, no
account, no cookie. Requests are sent without credentials and without a referrer.
The cite list and the word list are public and identical for every user, so
which list a workstation downloads says nothing about what is being drafted.
No word of the document is ever looked up anywhere: the word list is searched
in the pane's memory.

The server operator sees, per workstation, that the pane was opened and when a
list was fetched (IP address and time, as any web server does). A court that
does not want even that to reach a third party hosts the folder itself; see
[docs/deployment.md](docs/deployment.md). Then the only outside contact of the
workstation is Microsoft's script host, which Word contacts for any add-in.

## What enforces it

1. **Content-Security-Policy** in `addin/taskpane.html`:

   ```
   default-src 'none'; script-src 'self' https://appsforoffice.microsoft.com;
   style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self';
   base-uri 'none'; form-action 'none'
   ```

   `connect-src 'self'` makes the browser refuse every `fetch`, XHR, WebSocket,
   beacon or EventSource to any other origin, from our code and from
   Microsoft's script alike. `img-src`/`font-src`/`form-action` close the
   side doors (an image URL or a form post carrying text). No inline script, no
   `eval`. A court's web server should send the same policy as an HTTP header
   too, so that it holds even if the HTML were altered; the deployment guide
   has the line.
2. **The manifest declares no `AppDomains`**, so Word does not let the pane
   navigate anywhere else.
3. **The code has one place that talks to the network**, `addin/js/index.js`,
   two `fetch` calls: one for a manifest, which can only be `index.json` or
   `vocabulary.json`, and one for the file that manifest names, both under the
   page's own `index/` or `data/` directory. The file name is validated against
   `[A-Za-z0-9._-]+` so a manifest cannot point the download elsewhere.
4. **`tests/egress.test.mjs`** fails the build if the policy is loosened, if a
   second network API, another manifest name or an absolute URL appears in the
   code, if HTML is built from strings, or if `word.js` calls any Word method
   that writes other than `insertComment`, or creates anything other than a new
   document from the anonymized copy.

## How to verify it yourself

- Read the code: about 3,000 lines of JavaScript, no dependencies, no build
  step, no minified files. What is in the repository is what runs.
- Open the pane with the browser's developer tools (Windows: right-click in
  the pane, "Inspect", when add-in debugging is enabled) and watch the Network
  tab during a check: no request is made except the manifest (and, once, the
  list it names).
- Block the workstation's outbound traffic except to the add-in host and
  `appsforoffice.microsoft.com`: everything keeps working.
- "So lässt sich das prüfen" in the pane's footer shows the host, the list's
  file name and its SHA-256; compare with `sha256sum` on the server.

## The document

Outside Word (the page opened in a browser) a `.docx` can be chosen or dropped. It
is read with the browser's file API into the page's memory, unzipped there
(`addin/js/docx.js`, no library) and checked; it is not uploaded, and the policy
above would refuse an upload. The same holds for pasted text.


The anonymization check reads the whole file: in Word through
`Office.context.document.getFileAsync`, which hands the `.docx` to the pane;
outside Word through the browser's file API. The file is unzipped and read in
the pane's memory (`addin/js/docfile.js`), including what a reader does not
see: comments, tracked deletions, hidden text, field codes, image
descriptions, document properties and variables, `customXml/` parts, link
targets. The anonymized copy is written in memory too and checked again before
it is offered. In Word it is opened as a new, unsaved document
(`application.createDocument`); outside Word, or where Word cannot do that, it
is offered as a download from a `blob:` address of the page itself.

The add-in asks Word for `ReadWriteDocument` because attaching a comment is a
write. It calls these things: read the paragraphs (and footnotes) or the whole
file, select a range, insert a comment when the user presses the button, and
open a new document from the anonymized copy. It never edits the open
document: the anonymized copy is a separate file.
A court that wants Word itself to guarantee this generates the manifest with
`--read-only` (`ReadDocument`); comments are then unavailable, the rest works.

Text from the draft is placed in the pane with `textContent` only and is never
interpreted as HTML.

## The cite list as an input

The pane verifies the SHA-256 from `index.json` before using a download and
discards a list that does not match. This protects against a corrupted or
truncated transfer. It does not protect against an attacker who controls the
host, since `index.json` comes from the same place; such an attacker could
serve a list that makes a real decision look absent or an invented one look
present, though still not read the draft. A court that hosts the list itself
copies it together with its published checksum and is not exposed to this.
Signing the list with a key pinned in the add-in is planned.

The word list of the anonymization check is verified the same way. An
attacker who controls the host could add a name to it, and the check would
then explain that name as a common word instead of showing it. A court that
hosts the add-in itself, with the word list as published here (it is in the
repository, so every change is a visible diff), is not exposed to this.

What stays on the workstation between sessions: the cite list and the word
list (IndexedDB of the pane's origin), the interface language, the mode and
the placeholder style. Nothing about any document: not the file, not the
findings, not what was ticked.

## Reporting a problem

Open an issue at https://github.com/jonashertner/citecheck, or for something
that should not be public first, write to the address in the repository's
profile.
