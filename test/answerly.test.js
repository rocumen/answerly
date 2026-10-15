import test, { before } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { indexedDB } from "fake-indexeddb";

globalThis.indexedDB = indexedDB;
globalThis.chrome = { runtime: { getURL: (path) => new URL(`../${path}`, import.meta.url).href } };

let extractStudyFile;
let clearStudyFiles;
let saveStudyFile;
let findRelevantPassages;
let buildAnswerMessages;

before(async () => {
  ({ extractStudyFile } = await import("../vendor/file-parser.js"));
  ({ clearStudyFiles, saveStudyFile, findRelevantPassages } = await import("../study-store.js"));
  ({ buildAnswerMessages } = await import("../answer-prompt.js"));
});

test("extracts TXT and Markdown text with heading locations", async () => {
  const txt = await extractStudyFile(new File(["Cell membranes regulate transport."], "notes.txt"));
  assert.match(txt.sections.map((section) => section.text).join(" "), /regulate transport/);

  const markdown = await extractStudyFile(new File(["# Membranes\n\nThey regulate transport."], "notes.md"));
  assert.equal(markdown.sections[0].location, "Membranes");
  assert.match(markdown.sections[0].text, /regulate transport/);
});

test("extracts DOCX paragraphs and heading context", async () => {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Cell Structure</w:t></w:r></w:p><w:p><w:r><w:t>Mitochondria produce ATP for the cell.</w:t></w:r></w:p></w:body></w:document>`;
  const archive = zipSync({ "word/document.xml": strToU8(xml) });
  const docx = await extractStudyFile(new File([archive], "module.docx"));
  assert.equal(docx.sections[0].location, "Cell Structure · paragraph 2");
  assert.match(docx.sections[0].text, /produce ATP/);
});

test("extracts PPTX slide text with slide numbers", async () => {
  const slide1 = `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Photosynthesis</a:t></a:r></a:p></p:sld>`;
  const slide2 = `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Chlorophyll absorbs light.</a:t></a:r></a:p></p:sld>`;
  const archive = zipSync({
    "ppt/slides/slide1.xml": strToU8(slide1),
    "ppt/slides/slide2.xml": strToU8(slide2)
  });
  const pptx = await extractStudyFile(new File([archive], "module.pptx"));
  assert.equal(pptx.sections[1].location, "Slide 2");
  assert.match(pptx.sections[1].text, /absorbs light/);
});

test("extracts PDF page text", async () => {
  const pdf = makePdf("PDF text extraction works.");
  const document = await extractStudyFile(new File([pdf], "module.pdf"));
  assert.equal(document.sections[0].location, "Page 1");
  assert.match(document.sections[0].text, /text extraction works/);
});

test("stores files locally and selects question-relevant excerpts", async () => {
  await clearStudyFiles();
  await saveStudyFile({
    id: "local-test-module",
    name: "Biology module.pdf",
    addedAt: Date.now(),
    sections: [
      { location: "Page 7", text: "Mitochondria produce ATP through cellular respiration." },
      { location: "Page 19", text: "The cell membrane controls movement of substances into and out of the cell." }
    ]
  });
  const result = await findRelevantPassages("What do mitochondria produce?");
  assert.equal(result.hasFiles, true);
  assert.equal(result.passages[0].file, "Biology module.pdf");
  assert.equal(result.passages[0].location, "Page 7");
  assert.match(result.passages[0].text, /ATP/);
  await clearStudyFiles();
  assert.deepEqual(await findRelevantPassages("What is ATP?"), { hasFiles: false, passages: [] });
});

test("answer prompt treats documents as evidence and discloses lack of live search", () => {
  const withFile = buildAnswerMessages({ mode: "words", question: "What is ATP?", hasFiles: true, passages: [{ file: "notes.pdf", location: "Page 2", text: "ATP stores usable cellular energy." }] });
  assert.match(withFile[0].content, /untrusted reference data/);
  assert.match(withFile[1].content, /notes\.pdf/);
  assert.match(withFile[0].content, /only factual source/);

  const withoutFile = buildAnswerMessages({ mode: "words", question: "Who is the current president?", hasFiles: false });
  assert.match(withoutFile[0].content, /does not provide hosted web search/);
  assert.match(withoutFile[0].content, /Do not claim to have browsed/);
});

function makePdf(text) {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < bodies.length; index += 1) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${bodies[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  source += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(source, "ascii");
}
