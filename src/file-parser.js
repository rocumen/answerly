import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_COUNT = 10;
export const MAX_EXTRACTED_CHARS = 300_000;
const MAX_ARCHIVE_BYTES = 35 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_PDF_PAGES = 500;

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: true
});

export async function extractStudyFile(file) {
  const name = String(file?.name || "");
  const extension = name.split(".").pop()?.toLowerCase();
  if (!name || !["pdf", "docx", "pptx", "txt", "md", "markdown"].includes(extension)) {
    throw new Error(`${name || "This file"} has an unsupported type.`);
  }
  if (!file.size || file.size > MAX_FILE_BYTES) {
    throw new Error(`${name} must be between 1 byte and 20 MB.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sections = extension === "pdf"
    ? await extractPdf(bytes)
    : extension === "docx"
      ? extractDocx(bytes)
      : extension === "pptx"
        ? extractPptx(bytes)
        : extractTextFile(bytes, extension);
  const normalized = capSections(sections);
  if (!normalized.length) throw new Error(`No readable text was found in ${name}.`);
  return {
    id: crypto.randomUUID(),
    name,
    extension,
    size: file.size,
    addedAt: Date.now(),
    sections: normalized
  };
}

async function extractPdf(bytes) {
  let document;
  try {
    document = await pdfjs.getDocument({
      data: bytes,
      cMapUrl: chrome.runtime.getURL("vendor/cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL("vendor/standard_fonts/"),
      iccUrl: chrome.runtime.getURL("vendor/iccs/"),
      disableAutoFetch: true,
      isEvalSupported: false,
      useSystemFonts: true
    }).promise;
    if (document.numPages > MAX_PDF_PAGES) {
      throw new Error(`PDF has more than ${MAX_PDF_PAGES} pages.`);
    }
    const sections = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => typeof item.str === "string" ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
      if (text) sections.push(...chunkText(text, `Page ${pageNumber}`));
      if (sections.reduce((sum, section) => sum + section.text.length, 0) >= MAX_EXTRACTED_CHARS) break;
    }
    return sections;
  } finally {
    if (typeof document?.destroy === "function") {
      try { await document.destroy(); } catch { /* A parsed document remains usable until the popup closes. */ }
    }
  }
}

function extractDocx(bytes) {
  const files = unzipChecked(bytes);
  const documentBytes = files["word/document.xml"];
  if (!documentBytes) throw new Error("DOCX archive is missing its document body.");
  const xml = parseXml(documentBytes, "DOCX document");
  const paragraphs = findElements(xml, "p");
  const sections = [];
  let heading = "Document";
  let paragraphNumber = 0;
  for (const paragraph of paragraphs) {
    const text = collectText(paragraph).replace(/\s+/g, " ").trim();
    if (!text) continue;
    paragraphNumber += 1;
    const style = findAttributeInDescendants(paragraph, "pStyle", "val") || "";
    if (/^heading\d+$/i.test(style)) heading = text.slice(0, 120);
    else sections.push(...chunkText(text, `${heading} · paragraph ${paragraphNumber}`));
    if (sections.reduce((sum, section) => sum + section.text.length, 0) >= MAX_EXTRACTED_CHARS) break;
  }
  return sections;
}

function extractPptx(bytes) {
  const files = unzipChecked(bytes);
  const paths = Object.keys(files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)[1]) - Number(b.match(/slide(\d+)/i)[1]));
  if (!paths.length) throw new Error("PPTX archive has no slide text.");
  const sections = [];
  for (const path of paths) {
    const slideNumber = Number(path.match(/slide(\d+)/i)[1]);
    const xml = parseXml(files[path], `slide ${slideNumber}`);
    const paragraphs = findElements(xml, "p");
    const text = paragraphs.map((paragraph) => collectText(paragraph).replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
    if (text) sections.push(...chunkText(text, `Slide ${slideNumber}`));
    if (sections.reduce((sum, section) => sum + section.text.length, 0) >= MAX_EXTRACTED_CHARS) break;
  }
  return sections;
}

function extractTextFile(bytes, extension) {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "");
  if (extension !== "md" && extension !== "markdown") return chunkText(text, "Text");
  const sections = [];
  let heading = "Markdown";
  let body = [];
  const flush = () => {
    const value = body.join("\n").trim();
    if (value) sections.push(...chunkText(value, heading));
    body = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match) {
      flush();
      heading = match[1].slice(0, 120);
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

function parseXml(bytes, label) {
  try {
    const xml = xmlParser.parse(strFromU8(bytes));
    if (!xml || typeof xml !== "object") throw new Error("empty XML");
    return xml;
  } catch (error) {
    throw new Error(`Could not read ${label}: ${error.message}`);
  }
}

function findElements(root, localName) {
  const found = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("@_") || key === "#text") continue;
      if (key.split(":").at(-1) === localName) {
        if (Array.isArray(value)) found.push(...value);
        else found.push(value);
      }
      visit(value);
    }
  };
  visit(root);
  return found;
}

function collectText(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (!node || typeof node !== "object") return "";
  return Object.entries(node).map(([key, value]) => key === "#text" ? String(value) : key.startsWith("@_") ? "" : collectText(value)).join("");
}

function findAttributeInDescendants(root, elementName, attributeName) {
  for (const element of findElements(root, elementName)) {
    for (const [key, value] of Object.entries(element || {})) {
      if (key === `@_w:${attributeName}` || key === `@_${attributeName}`) return String(value);
    }
  }
  return "";
}

function unzipChecked(bytes) {
  checkZipDirectory(bytes);
  try {
    return unzipSync(bytes);
  } catch {
    throw new Error("The office document is damaged or uses an unsupported compression format.");
  }
}

function checkZipDirectory(bytes) {
  const minimum = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (read32(bytes, offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("The office file is not a valid ZIP document.");
  const entries = read16(bytes, endOffset + 10);
  const directoryOffset = read32(bytes, endOffset + 16);
  if (entries > MAX_ARCHIVE_ENTRIES || directoryOffset >= bytes.length) throw new Error("Office archive exceeds safe extraction limits.");
  let offset = directoryOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entries; index += 1) {
    if (read32(bytes, offset) !== 0x02014b50 || offset + 46 > bytes.length) throw new Error("The office document has a malformed ZIP directory.");
    const compressed = read32(bytes, offset + 20);
    const uncompressed = read32(bytes, offset + 24);
    const nameLength = read16(bytes, offset + 28);
    const extraLength = read16(bytes, offset + 30);
    const commentLength = read16(bytes, offset + 32);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) throw new Error("ZIP64 office documents are not supported.");
    if (uncompressed > MAX_ARCHIVE_BYTES) throw new Error("An office document entry exceeds the safe extraction limit.");
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_ARCHIVE_BYTES) throw new Error("Office document expands beyond the 35 MB extraction limit.");
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function read16(bytes, offset) {
  return offset + 2 <= bytes.length ? bytes[offset] | (bytes[offset + 1] << 8) : -1;
}

function read32(bytes, offset) {
  if (offset + 4 > bytes.length) return -1;
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function chunkText(text, location, maxLength = 1600) {
  const normalized = String(text || "").replace(/\u0000/g, "").trim();
  if (!normalized) return [];
  const chunks = [];
  for (let start = 0; start < normalized.length; start += maxLength) {
    let end = Math.min(start + maxLength, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf(" ", end);
      if (boundary > start + maxLength * 0.6) end = boundary;
    }
    chunks.push({ location: chunks.length ? `${location} (continued)` : location, text: normalized.slice(start, end).trim() });
    start = end - maxLength;
  }
  return chunks;
}

function capSections(sections) {
  const result = [];
  let remaining = MAX_EXTRACTED_CHARS;
  for (const section of sections) {
    if (remaining <= 0) break;
    const text = String(section?.text || "").trim().slice(0, remaining);
    if (text) {
      result.push({ location: String(section.location || "Document").slice(0, 160), text });
      remaining -= text.length;
    }
  }
  return result;
}
