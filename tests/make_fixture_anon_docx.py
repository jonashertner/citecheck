"""A .docx that hides a name everywhere a .docx can, for the anonymization tests.

The party is "Hans Müller"; the clerk of the court is also a Hans. The party appears: split across two formatting runs in the
body; as "Müllers" and "MÜLLER"; in a tracked deletion; in hidden text; in a
comment (and as its author); in the header and footer; in a footnote and an
endnote; in an image description; in a field code; in a mailto: link; as the
document's author; in a custom property, a document variable, the template
path and a customXml part a case-management system left behind; and in the
file name the test gives it. A thumbnail of page one is in docProps/.
"""
import sys
import zipfile

W = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
     'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
     'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"')
DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

DOCUMENT = DECL + f"""<w:document {W}><w:body>
<w:p><w:r><w:t xml:space="preserve">Der Beschwerdeführer Hans Mül</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>ler wohnt in Zürich.</w:t></w:r></w:p>
<w:p><w:commentRangeStart w:id="0"/><w:r><w:t xml:space="preserve">Müllers Antrag und MÜLLER selbst</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r><w:del w:author="Rita Gerber" w:id="1"><w:r><w:delText xml:space="preserve"> sowie Hans Müller</w:delText></w:r></w:del><w:ins w:author="Rita Gerber" w:id="2"><w:r><w:t xml:space="preserve"> sowie A.________</w:t></w:r></w:ins><w:r><w:t>.</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>Notiz: Müller anrufen.</w:t></w:r><w:r><w:t>Sichtbarer Text.</w:t></w:r><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t xml:space="preserve"> Auch sichtbar.</w:t></w:r></w:p>
<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> MERGEFIELD Partei_Mueller \\* MERGEFORMAT </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Feld</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:hyperlink r:id="rIdMail"><w:r><w:t>E-Mail</w:t></w:r></w:hyperlink><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:endnoteReference w:id="1"/></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Bild 1" descr="Foto von Hans Müller" title="Müller"/></wp:inline></w:drawing></w:r></w:p>
<w:p><w:r><w:t>Gerichtsschreiber Hans Wiprächtiger.</w:t></w:r></w:p>
<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/></w:sectPr>
</w:body></w:document>"""

FOOTNOTES = DECL + f"""<w:footnotes {W}>
<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
<w:footnote w:id="1"><w:p><w:r><w:t>Aussage von Müller vom 3. Mai.</w:t></w:r></w:p><w:p><w:r><w:t>Zweiter Absatz.</w:t></w:r></w:p></w:footnote>
</w:footnotes>"""
ENDNOTES = DECL + f"""<w:endnotes {W}>
<w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>
<w:endnote w:id="1"><w:p><w:r><w:t>Akten Müller.</w:t></w:r></w:p></w:endnote>
</w:endnotes>"""
HEADER = DECL + f'<w:hdr {W}><w:p><w:r><w:t>Verfahren Müller gegen Kanton</w:t></w:r></w:p></w:hdr>'
FOOTER = DECL + f'<w:ftr {W}><w:p><w:r><w:t>Entwurf Müller</w:t></w:r></w:p></w:ftr>'
COMMENTS = DECL + f"""<w:comments {W}>
<w:comment w:id="0" w:author="Peter Kunz" w:initials="PK"><w:p><w:r><w:annotationRef/></w:r><w:r><w:t>Müller noch ersetzen</w:t></w:r></w:p></w:comment>
</w:comments>"""
SETTINGS = DECL + f"""<w:settings {W}><w:trackRevisions/><w:attachedTemplate r:id="rIdTemplate"/><w:docVars><w:docVar w:name="Partei" w:val="Hans Müller"/></w:docVars><w:defaultTabStop w:val="708"/></w:settings>"""
STYLES = DECL + f'<w:styles {W}><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>'
CORE = DECL + """<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>Urteil Müller</dc:title><dc:creator>Rita Gerber</dc:creator><cp:lastModifiedBy>Rita Gerber</cp:lastModifiedBy><dcterms:created>2026-10-01T08:00:00Z</dcterms:created></cp:coreProperties>"""
APP = DECL + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Company>Kanzlei Gerber</Company><Pages>1</Pages></Properties>'
CUSTOM = DECL + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Partei"><vt:lpwstr>Hans Müller</vt:lpwstr></property></Properties>'
CUSTOM_XML = DECL + '<Fall><Partei>Hans Müller</Partei><Geburtsdatum>1970-04-03</Geburtsdatum></Fall>'
CONTENT_TYPES = DECL + """<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>
</Types>"""
RELS = DECL + """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/>
</Relationships>"""
DOC_RELS = DECL + """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
<Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
<Relationship Id="rIdFoot" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
<Relationship Id="rIdEnd" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>
<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
<Relationship Id="rIdCustom" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/>
<Relationship Id="rIdMail" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:hans.mueller@gmail.com" TargetMode="External"/>
</Relationships>"""
SETTINGS_RELS = DECL + """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdTemplate" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="file:///C:/Users/hmueller/Vorlagen/Urteil.dotm" TargetMode="External"/>
</Relationships>"""

PARTS = {
    "[Content_Types].xml": CONTENT_TYPES, "_rels/.rels": RELS,
    "word/document.xml": DOCUMENT, "word/_rels/document.xml.rels": DOC_RELS,
    "word/footnotes.xml": FOOTNOTES, "word/endnotes.xml": ENDNOTES,
    "word/header1.xml": HEADER, "word/footer1.xml": FOOTER, "word/comments.xml": COMMENTS,
    "word/settings.xml": SETTINGS, "word/_rels/settings.xml.rels": SETTINGS_RELS, "word/styles.xml": STYLES,
    "docProps/core.xml": CORE, "docProps/app.xml": APP, "docProps/custom.xml": CUSTOM,
    "customXml/item1.xml": CUSTOM_XML,
}

if __name__ == "__main__":
    with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in PARTS.items():
            z.writestr(name, text)
        z.writestr("docProps/thumbnail.jpeg", b"\xff\xd8\xff\xe0 not really a picture of page one")
        z.writestr("word/media/image1.png", b"\x89PNG not really an image")
