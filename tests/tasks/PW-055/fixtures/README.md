# PW-055 real-producer fixtures (synthetic text)
Made once and kept as files so the tests do not need the tools:
- `libreoffice-tracked.docx` from `libreoffice-tracked.fodt` — LibreOffice 24.2.7.2:
  `soffice -env:UserInstallation=file://<scratch>/lo-profile --headless --convert-to docx libreoffice-tracked.fodt`
  (one insertion, one deletion, one comment)
- `pandoc-paper.docx` from `pandoc-paper.md` — pandoc 3.1.3: `pandoc pandoc-paper.md -o pandoc-paper.docx`
  (headings, italic, a table, a footnote)
No file from a real paper or person is used.
