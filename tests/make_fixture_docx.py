"""A minimal .docx for tests: body with split runs, a tracked deletion, a no-break
hyphen, a table cell, a text box inside a paragraph, and two footnotes."""
import sys
import zipfile

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
DOCUMENT = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t xml:space="preserve">Vgl. BGE 140 </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>III 115 E. 2.3</w:t></w:r><w:del><w:r><w:delText> und BGE 99 II 1</w:delText></w:r></w:del><w:r><w:t xml:space="preserve"> sowie Urteil A</w:t><w:noBreakHyphen/><w:t>4843/2020.</w:t></w:r></w:p>
<w:p/>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>M&#252;ller &amp; S&#xF6;hne, Urteil 4A_747/2012</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>Aussen</w:t></w:r><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>Im Textfeld: 4C.230/2006</w:t></w:r></w:p></w:txbxContent></w:pict></w:r><w:r><w:tab/><w:t>danach</w:t><w:br/><w:t>Zeile</w:t></w:r></w:p>
</w:body></w:document>"""
FOOTNOTES = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes {W}>
<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
<w:footnote w:id="1"><w:p><w:r><w:t>BGE 140 III 134 S. 136.</w:t></w:r></w:p></w:footnote>
<w:footnote w:id="2"><w:p><w:r><w:t>Urteil 9C_1/2020.</w:t></w:r></w:p></w:footnote>
</w:footnotes>"""

if __name__ == "__main__":
    with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo("[Content_Types].xml"), "<Types/>", zipfile.ZIP_STORED)
        z.writestr("word/document.xml", DOCUMENT)
        z.writestr("word/footnotes.xml", FOOTNOTES)
