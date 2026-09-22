#!/usr/bin/env python3
"""Write the Office manifest for the host that serves the add-in.

    python build/make_manifest.py --base-url https://intranet.gericht.example/zitatpruefung/

The manifest is what Word installs: it names the URL of the task pane and the
permission the add-in asks for. --read-only asks for ReadDocument, so Word
itself refuses any change to the draft; "Als Kommentar setzen" then fails with
a message and the rest works. Standard library only.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from urllib.parse import urlsplit
from xml.sax.saxutils import quoteattr

ADDIN_ID = "1173d2d2-867d-4c54-a5ef-151b502f8fbf"
VERSION = "1.0.0.0"

TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
           xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"
           xsi:type="TaskPaneApp">
  <Id>{id}</Id>
  <Version>{version}</Version>
  <ProviderName>OpenCaseLaw</ProviderName>
  <DefaultLocale>de-CH</DefaultLocale>
  <DisplayName DefaultValue="citecheck Zitatprüfung">
    <Override Locale="fr-CH" Value="citecheck Contrôle des citations"/>
    <Override Locale="it-CH" Value="citecheck Controllo delle citazioni"/>
    <Override Locale="en-US" Value="citecheck"/>
  </DisplayName>
  <Description DefaultValue="Prüft die Verweise auf Entscheide im Entwurf gegen die Zitatliste von OpenCaseLaw. Der Entwurf verlässt das Gerät nicht.">
    <Override Locale="fr-CH" Value="Contrôle les renvois à des décisions dans le projet à l'aide de la liste d'OpenCaseLaw. Le projet ne quitte pas l'appareil."/>
    <Override Locale="it-CH" Value="Controlla i rinvii a decisioni nel progetto con la lista di OpenCaseLaw. Il progetto non lascia il dispositivo."/>
    <Override Locale="en-US" Value="Checks the draft's references to decisions against the OpenCaseLaw cite list. The draft does not leave the device."/>
  </Description>
  <IconUrl DefaultValue={icon32}/>
  <HighResolutionIconUrl DefaultValue={icon64}/>
  <SupportUrl DefaultValue="https://github.com/jonashertner/citecheck"/>
  <!-- No AppDomains: the task pane never navigates or connects beyond its own origin. -->
  <Hosts>
    <Host Name="Document"/>
  </Hosts>
  <Requirements>
    <Sets>
      <Set Name="WordApi" MinVersion="1.3"/>
    </Sets>
  </Requirements>
  <DefaultSettings>
    <SourceLocation DefaultValue={pane}/>
  </DefaultSettings>
  <Permissions>{permission}</Permissions>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
      <Host xsi:type="Document">
        <DesktopFormFactor>
          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabReviewWord">
              <Group id="Ocl.CiteCheck.Group">
                <Label resid="Ocl.Group"/>
                <Icon>
                  <bt:Image size="16" resid="Ocl.Icon16"/>
                  <bt:Image size="32" resid="Ocl.Icon32"/>
                  <bt:Image size="80" resid="Ocl.Icon80"/>
                </Icon>
                <Control xsi:type="Button" id="Ocl.CiteCheck.Open">
                  <Label resid="Ocl.Button"/>
                  <Supertip>
                    <Title resid="Ocl.Button"/>
                    <Description resid="Ocl.Tip"/>
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Ocl.Icon16"/>
                    <bt:Image size="32" resid="Ocl.Icon32"/>
                    <bt:Image size="80" resid="Ocl.Icon80"/>
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <TaskpaneId>Ocl.CiteCheck.Pane</TaskpaneId>
                    <SourceLocation resid="Ocl.Pane"/>
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>
        <bt:Image id="Ocl.Icon16" DefaultValue={icon16}/>
        <bt:Image id="Ocl.Icon32" DefaultValue={icon32}/>
        <bt:Image id="Ocl.Icon80" DefaultValue={icon80}/>
      </bt:Images>
      <bt:Urls>
        <bt:Url id="Ocl.Pane" DefaultValue={pane}/>
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="Ocl.Group" DefaultValue="OpenCaseLaw"/>
        <bt:String id="Ocl.Button" DefaultValue="Zitate prüfen">
          <bt:Override Locale="fr-CH" Value="Contrôler les citations"/>
          <bt:Override Locale="it-CH" Value="Controllare le citazioni"/>
          <bt:Override Locale="en-US" Value="Check cites"/>
        </bt:String>
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="Ocl.Tip" DefaultValue="Vergleicht die Verweise auf Entscheide mit der Zitatliste. Der Entwurf bleibt auf diesem Gerät.">
          <bt:Override Locale="fr-CH" Value="Compare les renvois à des décisions avec la liste. Le projet reste sur cet appareil."/>
          <bt:Override Locale="it-CH" Value="Confronta i rinvii a decisioni con la lista. Il progetto resta su questo dispositivo."/>
          <bt:Override Locale="en-US" Value="Compares the references to decisions with the cite list. The draft stays on this device."/>
        </bt:String>
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>
"""


def render(base_url: str, read_only: bool = False) -> str:
    parts = urlsplit(base_url)
    local = parts.hostname in ("localhost", "127.0.0.1")
    if parts.scheme != "https" and not (parts.scheme == "http" and local):
        raise ValueError("Office loads add-ins over https only (http is accepted for localhost)")
    base = base_url if base_url.endswith("/") else base_url + "/"
    return TEMPLATE.format(
        id=ADDIN_ID, version=VERSION, permission="ReadDocument" if read_only else "ReadWriteDocument",
        pane=quoteattr(base + "taskpane.html"),
        **{f"icon{n}": quoteattr(f"{base}assets/icon-{n}.png") for n in (16, 32, 64, 80)})


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--base-url", required=True, help="where the addin/ folder is served, e.g. https://intranet.example/zitatpruefung/")
    ap.add_argument("--read-only", action="store_true", help="ask Word for ReadDocument only (no comments)")
    ap.add_argument("--out", type=Path, default=Path("manifest.xml"))
    args = ap.parse_args(argv)
    try:
        xml = render(args.base_url, args.read_only)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    args.out.write_text(xml, encoding="utf-8")
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
