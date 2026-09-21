# Data flow and security

The claim: **the draft, the references found in it and the results never leave
the workstation.** This page says what that rests on and how to check it
without trusting us.

## What crosses the network

| Request | To | Contains | When |
|---|---|---|---|
| The add-in's files (HTML, CSS, JS, icons) | the host in the manifest: your intranet server, or ours | nothing about the document | when the pane opens |
| `index/index.json` (a few KB) | the same host | nothing about the document | pane opens; "Liste aktualisieren"; before a check if the last answer is older than 4 h |
| `index/cite-index-<date>.tsv.gz` | the same host | nothing about the document | only when `index.json` names a list the pane does not have |
| `office.js` | `appsforoffice.microsoft.com` | nothing about the document | when the pane opens; Microsoft requires every Office add-in to load it from there |

That is the complete list. There is no telemetry, no error reporting, no
account, no cookie. Requests are sent without credentials and without a referrer.
The cite list is public and identical for every user, so which list a
workstation downloads says nothing about what is being drafted.

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
   two `fetch` calls, both to paths under the page's own `index/` directory.
   The list's file name is validated against `[A-Za-z0-9._-]+` so a manifest
   cannot point the download elsewhere.
4. **`tests/egress.test.mjs`** fails the build if the policy is loosened, if a
   second network API or an absolute URL appears in the code, if HTML is built
   from strings, or if `word.js` calls any Word method that writes other than
   `insertComment`.

## How to verify it yourself

- Read the code: about 1,400 lines of JavaScript, no dependencies, no build
  step, no minified files. What is in the repository is what runs.
- Open the pane with the browser's developer tools (Windows: right-click in
  the pane, "Inspect", when add-in debugging is enabled) and watch the Network
  tab during a check: no request is made.
- Block the workstation's outbound traffic except to the add-in host and
  `appsforoffice.microsoft.com`: everything keeps working.
- "So lässt sich das prüfen" in the pane's footer shows the host, the list's
  file name and its SHA-256; compare with `sha256sum` on the server.

## The document

The add-in asks Word for `ReadWriteDocument` because attaching a comment is a
write. It calls three things: read the paragraphs (and footnotes), select a
range, insert a comment when the user presses the button. It never edits text.
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

What stays on the workstation between sessions: the cite list (IndexedDB of
the pane's origin) and the chosen interface language. Nothing about any draft.

## Reporting a problem

Open an issue at https://github.com/jonashertner/citecheck, or for something
that should not be public first, write to the address in the repository's
profile.
