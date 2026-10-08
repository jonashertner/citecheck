"""A .docx with the hiding places of the Word test of 2026-10-08 (report
OCL-CITECHECK-WORD-20261008): text hidden by a character style, a content
control whose name and tag hold a person, an https link whose target holds a
name and an e-mail address, a double name joined by Word's non-breaking hyphen,
and a surname written with a combining umlaut (u + U+0308).
"""
import sys
import zipfile

W = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
     'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

DOCUMENT = DECL + f"""<w:document {W}><w:body>
<w:p><w:r><w:t xml:space="preserve">Sichtbar. </w:t></w:r><w:r><w:rPr><w:rStyle w:val="Versteckt"/></w:rPr><w:t>Benno Unsichtbar benno@example.org</w:t></w:r></w:p>
<w:sdt><w:sdtPr><w:alias w:val="Partei Emma Musterperson"/><w:tag w:val="lukas.sdt@example.org"/><w:id w:val="1"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Inhalt des Steuerelements.</w:t></w:r></w:p></w:sdtContent></w:sdt>
<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>Weiterer Link</w:t></w:r></w:hyperlink></w:p>
<w:p><w:r><w:t xml:space="preserve">Der Sohn Lea Brunner</w:t></w:r><w:r><w:noBreakHyphen/></w:r><w:r><w:t xml:space="preserve">Keller bestritt dies.</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Hans Müller sagt aus.</w:t></w:r></w:p>
<w:sectPr/>
</w:body></w:document>"""
STYLES = DECL + f"""<w:styles {W}>
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="character" w:styleId="Basis"><w:name w:val="Basis"/><w:rPr><w:vanish/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Versteckt"><w:name w:val="Versteckt"/><w:basedOn w:val="Basis"/></w:style>
</w:styles>"""
CONTENT_TYPES = DECL + """<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"""
RELS = DECL + """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""
DOC_RELS = DECL + """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/qa/Emma%20Musterperson?email=emma.link@example.org" TargetMode="External"/>
</Relationships>"""

with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for name, text in {"[Content_Types].xml": CONTENT_TYPES, "_rels/.rels": RELS, "word/document.xml": DOCUMENT,
                       "word/_rels/document.xml.rels": DOC_RELS, "word/styles.xml": STYLES}.items():
        z.writestr(name, text)
