# Deployment, for a court's IT

The add-in is a folder of static files and a manifest. There is nothing to
install on the workstations and nothing to run on a server beyond serving files.

Requirements: Word from Microsoft 365 or Office 2021 and later on Windows
(WebView2), or current Word for Mac. An internal web server with HTTPS.

## 1. Serve the folder

Copy `addin/` to an internal web server, for example to
`https://intranet.gericht.example/zitatpruefung/`. Any server will do; the
files are static. Send the policy as a header as well (nginx):

```nginx
location /zitatpruefung/ {
    add_header Content-Security-Policy "default-src 'none'; script-src 'self' https://appsforoffice.microsoft.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Content-Type-Options "nosniff" always;
    location /zitatpruefung/index/ { add_header Cache-Control "no-cache" always; }
}
```

Do not add `X-Frame-Options` or `frame-ancestors`: Word on the web shows add-ins
in a frame.

## 2. Put the cite list next to it

`addin/index/` must hold `index.json` and the one `cite-index-<date>.tsv.gz` it
names. Two ways:

- **Mirror** the published list on a schedule (a cron job or scheduled task on
  the server: download both files, verify the SHA-256 in `index.json` against
  the `.tsv.gz`, then move them into place, `index.json` last). The
  workstations then never contact anyone outside but Microsoft's script host.
- **Build** it from the OpenCaseLaw verification pack, which is public and
  checksummed (`ocl pack pull`, about 8 GB):

  ```
  python build/build_cite_index.py --pack verification_pack.sqlite --out /srv/zitatpruefung/index
  ```

  Python 3.10 or later, standard library only. The pack is rebuilt weekly.

The builder and a mirror script both write the list file first and replace
`index.json` last, so a workstation never reads a manifest without its file.

## 3. Generate the manifest

```
python build/make_manifest.py --base-url https://intranet.gericht.example/zitatpruefung/
```

Add `--read-only` to have Word grant `ReadDocument` only: Word then refuses any
write by the add-in, including comments.

## 4. Make it available in Word

- **Microsoft 365 tenant**: Microsoft 365 admin centre, Settings, Integrated
  apps, Upload custom apps, upload `manifest.xml`, assign to the users or
  groups. The button "Zitate prüfen" appears on the Review tab.
- **Without a tenant (Windows)**: put `manifest.xml` on a file share, and in
  Word under File, Options, Trust Center, Trust Center Settings, Trusted Add-in
  Catalogs add the share's UNC path and tick "Show in Menu". By group policy:
  the same setting under the Office administrative templates. Users then find
  the add-in under Insert, Get Add-ins, Shared Folder.

## 5. Check the installation

1. Open a document, Review, "Zitate prüfen". The pane names the list's date
   and the number of decisions.
2. Footer, "So lässt sich das prüfen": the host shown is yours, and the
   SHA-256 equals `sha256sum` of the list file on the server.
3. With the developer tools open on the pane (or at the proxy), run a check:
   no request leaves during the check.

## Updating

Replace the files in the folder; the workstations pick them up the next time
the pane opens. The manifest only changes when the URL or the permission
changes. A new list is a new pair of files in `index/`.
