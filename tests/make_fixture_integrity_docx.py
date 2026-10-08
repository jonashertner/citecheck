"""Small .docx files for the surfaces of the deep check of 2026-10-09 (OCL-CITECHECK-DEEP-20261009).

    python make_fixture_integrity_docx.py OUT.docx MODE

MODE textbox   a hidden text box before a selected e-mail, then a paragraph that must stay (SURF-01)
     simple    an e-mail in a simple field's instruction, w:fldSimple/@w:instr (SURF-02)
     default   the default paragraph style hides its text; one paragraph names a visible style (SURF-03)
     quotes    w:vanish w:val='false' in single quotes: visible (SURF-04)
     alias     the Word namespace under "q:" instead of "w:" (SURF-05)
     url       a link whose target has escaped delimiters beside a name (URL encoding)
"""
import sys
import zipfile

out, mode = sys.argv[1], sys.argv[2]
NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
P = "q" if mode == "alias" else "w"
W = (f'xmlns:{P}="{NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
     'xmlns:v="urn:schemas-microsoft-com:vml"')
DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'


def para(text, rpr="", ppr=""):
    return f'<{P}:p>{ppr}<{P}:r>{rpr}<{P}:t xml:space="preserve">{text}</{P}:t></{P}:r></{P}:p>'


body = {
    "textbox": (
        '<w:p><w:r><w:t xml:space="preserve">Vor dem Feld. </w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:pict><v:shape><v:textbox>'
        '<w:txbxContent><w:p><w:r><w:t>Versteckt im Textfeld</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>'
        + para("Kontakt: lea.person@example.org, bitte.")
        + para("This separate paragraph must stay exactly as written.")),
    "simple": ('<w:p><w:fldSimple w:instr=" HYPERLINK &quot;mailto:lea.simple@example.org&quot; ">'
               '<w:r><w:t>E-Mail</w:t></w:r></w:fldSimple></w:p>' + para("Weiterer Text.")),
    "default": para("Versteckt durch die Standardvorlage.") + para("Sichtbar mit eigener Vorlage.", ppr='<w:pPr><w:pStyle w:val="Sichtbar"/></w:pPr>'),
    "quotes": para("Sichtbar trotz vanish.", rpr="<w:rPr><w:vanish w:val='false'/></w:rPr>") + para("Versteckt.", rpr="<w:rPr><w:vanish w:val='1'/></w:rPr>"),
    "alias": para("Hans Muster wohnt hier.") + para("Zweiter Absatz."),
    "url": '<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>Profil</w:t></w:r></w:hyperlink></w:p>' + para("Emma Muster sagt aus."),
}[mode]
styles = {
    "default": ('<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:vanish/></w:rPr></w:style>'
                '<w:style w:type="paragraph" w:styleId="Sichtbar"><w:name w:val="Sichtbar"/><w:basedOn w:val="Normal"/><w:rPr><w:vanish w:val="0"/></w:rPr></w:style>'),
}.get(mode, '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>')
link = ('<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" '
        'Target="https://example.org/a%2Fb?x=1%26y%3D2&amp;name=Emma%20Muster" TargetMode="External"/>') if mode == "url" else ""
files = {
    "[Content_Types].xml": DECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    "_rels/.rels": DECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/_rels/document.xml.rels": DECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' + link + '</Relationships>',
    "word/document.xml": DECL + f'<{P}:document {W}><{P}:body>{body}<{P}:sectPr/></{P}:body></{P}:document>',
    "word/styles.xml": DECL + f'<w:styles xmlns:w="{NS}">{styles}</w:styles>',
}
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for name, text in files.items():
        z.writestr(name, text)
