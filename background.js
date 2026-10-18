import { findRelevantPassages } from "./study-store.js";
import { buildAnswerMessages } from "./answer-prompt.js";

const API_URL = "https://api.deeprelay.ai/v1/chat/completions";
const MODEL_IDS = new Set([
  "deeprelay/deepseek-v4.1-flash",
  "deeprelay/kimi-k3",
  "deeprelay/glm-5.3",
  "deeprelay/glm-5.3-flash"
]);
const VISION_MODEL_IDS = new Set([
  "deeprelay/kimi-k3",
  "deeprelay/glm-5.3-flash"
]);
const MAX_QUESTION_CHARS = 12000;
const MAX_OPTIONS = 40;
const activeRequests = new Map();

chrome.commands.onCommand.addListener(async (command) => {
  const commandTypes = {
    "answer-multiple-choice": "ANSWERLY_MULTIPLE_CHOICE",
    "answer-in-words": "ANSWERLY_WORDS",
    "answer-from-image": "ANSWERLY_ARM_IMAGE_CAPTURE",
    "clear-answers": "ANSWERLY_CLEAR_OUTPUT"
  };
  const type = commandTypes[command];
  if (!type) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  try {
    // Inject only after the user invokes a shortcut, then deliver the matching page action.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type });
  } catch (error) {
    // This error is available in the extension service worker's Inspect view on chrome://extensions.
    console.error("Answerly shortcut could not inject or message the active page.", error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ([
    "ANSWERLY_GET_EDITOR_SELECTION",
    "ANSWERLY_REPLACE_EDITOR_SELECTION",
    "ANSWERLY_SHOW_EDITOR_STATUS",
    "ANSWERLY_FINISH_EDITOR_STATUS"
  ].includes(message?.type)) {
    const tabId = _sender.tab?.id;
    const token = String(message.token ?? "");
    if (!Number.isInteger(tabId) || !token) {
      sendResponse({ ok: false });
      return false;
    }
    const isRead = message.type === "ANSWERLY_GET_EDITOR_SELECTION";
    const isShow = message.type === "ANSWERLY_SHOW_EDITOR_STATUS";
    const isFinish = message.type === "ANSWERLY_FINISH_EDITOR_STATUS";
    const func = isRead ? readSupportedEditorSelection
      : isShow ? showSupportedEditorStatus
        : isFinish ? finishSupportedEditorStatus
          : replaceSupportedEditorSelection;
    const args = isRead || isShow
      ? [token]
      : isFinish ? [token, String(message.text ?? "").slice(0, MAX_QUESTION_CHARS)]
        : [token, String(message.text ?? "").slice(0, MAX_QUESTION_CHARS)];
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func,
      args
    }).then((results) => {
      const result = results?.[0]?.result;
      sendResponse(isRead
        ? { ok: true, selection: result || null }
        : isShow ? { ok: true, shown: result === true }
          : { ok: true, replaced: result === true });
    }).catch(() => sendResponse(isRead
      ? { ok: false, selection: null }
      : isShow ? { ok: false, shown: false }
        : { ok: false, replaced: false }));
    return true;
  }
  if (message?.type === "ANSWERLY_CANCEL_REQUEST") {
    activeRequests.get(String(message.requestId))?.abort();
    return false;
  }
  if (message?.type === "ANSWERLY_IMAGE_REQUEST") {
    const requestId = String(message.requestId ?? "");
    const tabId = _sender.tab?.id;
    const windowId = _sender.tab?.windowId;
    if (!requestId || !Number.isInteger(tabId) || !Number.isInteger(windowId)) {
      sendResponse({ ok: false, error: "Could not capture this tab. Try Alt+R again." });
      return false;
    }
    const controller = new AbortController();
    activeRequests.set(requestId, controller);
    answerImageQuestion(message.payload, tabId, windowId, controller.signal)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }))
      .finally(() => {
        if (activeRequests.get(requestId) === controller) activeRequests.delete(requestId);
      });
    return true;
  }
  if (message?.type !== "ANSWERLY_ANSWER_REQUEST") return false;

  const requestId = String(message.requestId ?? "");
  if (!requestId) {
    sendResponse({ ok: false, error: "Missing request identifier." });
    return false;
  }
  const controller = new AbortController();
  activeRequests.set(requestId, controller);
  answerQuestion(message.payload, controller.signal)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }))
    .finally(() => {
      if (activeRequests.get(requestId) === controller) activeRequests.delete(requestId);
    });
  return true;
});

function readSupportedEditorSelection(token) {
  const storeKey = Symbol.for("answerly.editorSelections");
  const store = globalThis[storeKey] || (globalThis[storeKey] = new Map());
  for (const [key, value] of store) if (Date.now() - value.createdAt > 120000) store.delete(key);
  const active = document.activeElement;
  const save = (entry) => {
    if (!entry?.text || !entry.snapshot) return null;
    store.set(token, { ...entry, createdAt: Date.now() });
    return { text: entry.text };
  };

  const cmWrappers = [...document.querySelectorAll(".CodeMirror")];
  for (const wrapper of cmWrappers) {
    const editor = wrapper.CodeMirror;
    if (!editor || !(editor.hasFocus?.() || wrapper.contains(active))) continue;
    const selections = editor.listSelections?.() || [];
    if (selections.length !== 1) continue;
    const text = editor.getSelection?.() || "";
    if (!text.trim()) continue;
    const point = (value) => ({ line: value.line, ch: value.ch });
    return save({
      type: "codemirror",
      editor,
      text,
      end: point(editor.getCursor("to")),
      snapshot: selections.map(({ anchor, head }) => ({ anchor: point(anchor), head: point(head) }))
    });
  }

  const aceRoots = [...document.querySelectorAll(".ace_editor")];
  for (const root of aceRoots) {
    if (!(root.contains(active) || root.matches(":focus-within"))) continue;
    let editor = root.env?.editor;
    if (!editor && globalThis.ace?.edit) {
      try { editor = globalThis.ace.edit(root); } catch { /* Not an initialized Ace editor. */ }
    }
    if (!editor?.getSelectedText || !editor?.getSelectionRange) continue;
    const text = editor.getSelectedText();
    if (!text.trim()) continue;
    const range = editor.getSelectionRange();
    const snapshot = {
      start: { row: range.start.row, column: range.start.column },
      end: { row: range.end.row, column: range.end.column }
    };
    return save({ type: "ace", editor, text, snapshot });
  }

  const monacoEditors = globalThis.monaco?.editor?.getEditors?.() || [];
  for (const editor of monacoEditors) {
    const root = editor.getDomNode?.();
    if (!(editor.hasTextFocus?.() || root?.contains(active))) continue;
    const model = editor.getModel?.();
    const selection = editor.getSelection?.();
    if (!model || !selection || selection.isEmpty?.()) continue;
    const text = model.getValueInRange(selection);
    if (!text.trim()) continue;
    return save({ type: "monaco", editor, model, text, snapshot: selection });
  }
  return null;
}

function replaceSupportedEditorSelection(token, text) {
  const store = globalThis[Symbol.for("answerly.editorSelections")];
  const entry = store?.get(token);
  store?.delete(token);
  if (!entry || !text || entry.text.length > 20000) return false;
  const prefix = /[\r\n]$/.test(entry.text) ? "" : "\n";
  const suffix = /[\r\n]$/.test(text) ? "" : "\n";
  const insertionText = `${prefix}${text}${suffix}`;

  if (entry.type === "codemirror") {
    const selections = entry.editor.listSelections?.() || [];
    const same = JSON.stringify(selections.map(({ anchor, head }) => ({
      anchor: { line: anchor.line, ch: anchor.ch },
      head: { line: head.line, ch: head.ch }
    }))) === JSON.stringify(entry.snapshot);
    if (!same || entry.editor.getSelection?.() !== entry.text) return false;
    entry.editor.replaceRange(insertionText, entry.end, entry.end, "+answerly");
    return true;
  }

  if (entry.type === "ace") {
    const range = entry.editor.getSelectionRange?.();
    if (!range || range.start.row !== entry.snapshot.start.row || range.start.column !== entry.snapshot.start.column ||
        range.end.row !== entry.snapshot.end.row || range.end.column !== entry.snapshot.end.column ||
        entry.editor.getSelectedText?.() !== entry.text) return false;
    entry.editor.clearSelection();
    entry.editor.moveCursorToPosition(entry.snapshot.end);
    entry.editor.insert(insertionText);
    return true;
  }

  if (entry.type === "monaco") {
    const model = entry.editor.getModel?.();
    const selection = entry.editor.getSelection?.();
    if (model !== entry.model || !selection || model.getValueInRange(selection) !== entry.text ||
        selection.startLineNumber !== entry.snapshot.startLineNumber ||
        selection.startColumn !== entry.snapshot.startColumn ||
        selection.endLineNumber !== entry.snapshot.endLineNumber ||
        selection.endColumn !== entry.snapshot.endColumn) return false;
    const end = { lineNumber: selection.endLineNumber, column: selection.endColumn };
    const collapsedRange = {
      startLineNumber: end.lineNumber,
      startColumn: end.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column
    };
    return entry.editor.executeEdits("answerly", [{ range: collapsedRange, text: insertionText, forceMoveMarkers: true }]) === true;
  }
  return false;
}

function showSupportedEditorStatus(token) {
  const insertionFor = (selectedText, text) => {
    const prefix = /[\r\n]$/.test(selectedText) ? "" : "\n";
    const suffix = /[\r\n]$/.test(text) ? "" : "\n";
    return `${prefix}${text}${suffix}`;
  };
  const sameAceRange = (range, snapshot) => Boolean(range) &&
    range.start.row === snapshot.start.row && range.start.column === snapshot.start.column &&
    range.end.row === snapshot.end.row && range.end.column === snapshot.end.column;
  const sameMonacoSelection = (selection, snapshot) => Boolean(selection) &&
    selection.startLineNumber === snapshot.startLineNumber && selection.startColumn === snapshot.startColumn &&
    selection.endLineNumber === snapshot.endLineNumber && selection.endColumn === snapshot.endColumn;
  const commentPrefix = (entry) => {
    const mode = entry.type === "ace" ? entry.editor.session.getMode?.().$id
      : entry.type === "monaco" ? entry.model.getLanguageId?.()
        : entry.editor.getMode?.().name;
    return /python|ruby|shell|bash|yaml|toml|perl|powershell/i.test(String(mode || "")) ? "#" : "//";
  };
  const store = globalThis[Symbol.for("answerly.editorSelections")];
  const entry = store?.get(token);
  if (!entry || entry.status) return false;
  const statusText = `${commentPrefix(entry)} Thinking…`;
  const insertionText = insertionFor(entry.text, statusText);

  if (entry.type === "codemirror") {
    const selections = entry.editor.listSelections?.() || [];
    if (JSON.stringify(selections.map(({ anchor, head }) => ({
      anchor: { line: anchor.line, ch: anchor.ch },
      head: { line: head.line, ch: head.ch }
    }))) !== JSON.stringify(entry.snapshot) || entry.editor.getSelection?.() !== entry.text) return false;
    const start = entry.end;
    const startIndex = entry.editor.indexFromPos(start);
    entry.editor.replaceRange(insertionText, start, start, "+answerly-status");
    entry.status = {
      start,
      end: entry.editor.posFromIndex(startIndex + insertionText.length),
      text: insertionText
    };
    return true;
  }

  if (entry.type === "ace") {
    const range = entry.editor.getSelectionRange?.();
    if (!sameAceRange(range, entry.snapshot) || entry.editor.getSelectedText?.() !== entry.text) return false;
    const doc = entry.editor.session.getDocument();
    const startIndex = doc.positionToIndex(entry.snapshot.end);
    entry.editor.clearSelection();
    entry.editor.moveCursorToPosition(entry.snapshot.end);
    entry.editor.insert(insertionText);
    entry.status = {
      start: doc.indexToPosition(startIndex),
      end: doc.indexToPosition(startIndex + insertionText.length),
      text: insertionText
    };
    return true;
  }

  if (entry.type === "monaco") {
    const model = entry.editor.getModel?.();
    const selection = entry.editor.getSelection?.();
    if (model !== entry.model || !sameMonacoSelection(selection, entry.snapshot) ||
        model.getValueInRange(selection) !== entry.text) return false;
    const start = { lineNumber: selection.endLineNumber, column: selection.endColumn };
    const startOffset = model.getOffsetAt(start);
    const editRange = {
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: start.lineNumber,
      endColumn: start.column
    };
    if (entry.editor.executeEdits("answerly-status", [{ range: editRange, text: insertionText, forceMoveMarkers: true }]) !== true) return false;
    entry.status = {
      start: model.getPositionAt(startOffset),
      end: model.getPositionAt(startOffset + insertionText.length),
      text: insertionText
    };
    return true;
  }
  return false;
}

function finishSupportedEditorStatus(token, replacementText) {
  const insertionFor = (selectedText, text) => {
    const prefix = /[\r\n]$/.test(selectedText) ? "" : "\n";
    const suffix = /[\r\n]$/.test(text) ? "" : "\n";
    return `${prefix}${text}${suffix}`;
  };
  const store = globalThis[Symbol.for("answerly.editorSelections")];
  const entry = store?.get(token);
  if (!entry?.status) {
    store?.delete(token);
    return false;
  }
  const { start, end, text: currentStatus } = entry.status;
  const replacement = replacementText ? insertionFor(entry.text, replacementText) : "";
  let replaced = false;

  if (entry.type === "codemirror" && entry.editor.getRange(start, end) === currentStatus) {
    entry.editor.replaceRange(replacement, start, end, "+answerly-finish");
    replaced = true;
  } else if (entry.type === "ace") {
    const session = entry.editor.session;
    const current = session.getTextRange({ start, end });
    if (current === currentStatus) {
      session.replace({ start, end }, replacement);
      replaced = true;
    }
  } else if (entry.type === "monaco") {
    const model = entry.editor.getModel?.();
    const range = {
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column
    };
    if (model === entry.model && model.getValueInRange(range) === currentStatus) {
      replaced = entry.editor.executeEdits("answerly-finish", [{ range, text: replacement, forceMoveMarkers: true }]) === true;
    }
  }

  store?.delete(token);
  return replaced;
}

async function answerQuestion(payload, signal) {
  const { apiKey = "", model = "deeprelay/deepseek-v4.1-flash", answerInstructions = "" } = await chrome.storage.local.get(["apiKey", "model", "answerInstructions"]);
  if (!apiKey.trim()) throw new Error("Add your Deep Relay API key in the extension settings first.");
  if (!MODEL_IDS.has(model)) throw new Error("Choose a supported model in the extension settings.");

  const mode = payload?.mode === "multiple-choice" ? "multiple-choice" : "words";
  const question = String(payload?.question ?? "").trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) throw new Error("Highlight a question before using the shortcut.");
  const options = Array.isArray(payload?.options)
    ? payload.options.slice(0, MAX_OPTIONS).map((option) => ({
        id: String(option.id),
        text: String(option.text ?? "").trim().slice(0, 1000)
      })).filter((option) => option.text)
    : [];
  const reference = await findRelevantPassages(question);
  const passages = reference.passages;
  if (mode === "multiple-choice" && options.length < 2) {
    throw new Error("No multiple-choice radio options were found near the highlighted question.");
  }

  const schema = mode === "multiple-choice"
    ? {
        type: "object",
        additionalProperties: false,
        properties: {
          answer: { type: "string" },
          explanation: { type: "string" },
          correctOptionId: { type: ["string", "null"] },
          citations: citationSchema()
        },
        required: ["answer", "explanation", "correctOptionId", "citations"]
      }
    : {
        type: "object",
        additionalProperties: false,
        properties: {
          answer: { type: "string" },
          explanation: { type: "string" },
          correctOptionId: { type: ["string", "null"] },
          citations: citationSchema()
        },
        required: ["answer", "explanation", "correctOptionId", "citations"]
      };

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey.trim()}`
    },
    body: JSON.stringify({
      model,
      messages: buildAnswerMessages({ mode, question, options, hasFiles: reference.hasFiles, passages, customInstructions: answerInstructions }),
      temperature: 0.2,
      max_tokens: 700,
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer_result", strict: true, schema }
      }
    }),
    signal
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `Deep Relay request failed (${response.status}).`);
  }
  const content = body?.choices?.[0]?.message?.content;
  const text = typeof content === "string"
    ? content.trim()
    : Array.isArray(content)
      ? content.map((part) => typeof part?.text === "string" ? part.text : "").join("").trim()
      : "";
  if (!text) throw new Error("The AI returned an empty answer. Try again.");

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error("The AI response was not valid JSON. Try again.");
  }
  if (typeof result.answer !== "string" || typeof result.explanation !== "string") {
    throw new Error("The AI response did not contain a valid answer.");
  }
  const validIds = new Set(options.map((option) => option.id));
  if (mode === "multiple-choice" && result.correctOptionId !== null && !validIds.has(String(result.correctOptionId))) {
    throw new Error("The AI answer did not match any detected radio choice. Try again.");
  }
  const validCitations = new Set(passages.map((passage) => `${passage.file}\u0000${passage.location}`));
  const citations = Array.isArray(result.citations)
    ? result.citations.filter((citation) => validCitations.has(`${citation.file}\u0000${citation.location}`)).slice(0, 3)
    : [];
  return {
    answer: result.answer.slice(0, 4000),
    explanation: result.explanation.slice(0, 6000),
    correctOptionId: mode === "multiple-choice" && result.correctOptionId !== null ? String(result.correctOptionId) : null,
    citations
  };
}

async function answerImageQuestion(payload, tabId, windowId, signal) {
  const {
    apiKey = "",
    model = "deeprelay/deepseek-v4.1-flash",
    answerInstructions = ""
  } = await chrome.storage.local.get(["apiKey", "model", "answerInstructions"]);
  if (!apiKey.trim()) throw new Error("Add your Deep Relay API key in the extension settings first.");
  if (!VISION_MODEL_IDS.has(model)) {
    throw new Error("Alt+R needs a vision model. Choose Kimi K3 or GLM 5.3 Flash in Answerly settings.");
  }
  const imageDataUrl = await captureImageRegion(tabId, windowId, payload?.imageRect, payload?.viewport);
  const question = String(payload?.question ?? "Read and answer the question shown in the attached image.")
    .trim().slice(0, MAX_QUESTION_CHARS);
  const reference = await findRelevantPassages(question);
  const passages = reference.passages;
  return requestAnswer({
    mode: "image",
    question,
    options: [],
    hasFiles: reference.hasFiles,
    passages,
    imageDataUrl,
    customInstructions: answerInstructions,
    signal
  });
}

async function captureImageRegion(tabId, windowId, rect, viewport) {
  if (![rect?.x, rect?.y, rect?.width, rect?.height, viewport?.width, viewport?.height]
    .every((value) => Number.isFinite(Number(value)))) {
    throw new Error("Could not identify the clicked image area. Press Alt+R and click the image again.");
  }
  let screenshot;
  try {
    // Capture the visible tab only after Alt+R is invoked and the user clicks the target area.
    screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch {
    throw new Error("Could not capture this page. Check that the tab is active, then try Alt+R again.");
  }
  const source = await createImageBitmap(await (await fetch(screenshot)).blob());
  const scaleX = source.width / Number(viewport.width);
  const scaleY = source.height / Number(viewport.height);
  const padX = Math.max(20, Number(rect.width) * 0.04);
  const padY = Math.max(20, Number(rect.height) * 0.04);
  const x = Math.max(0, Math.floor((Number(rect.x) - padX) * scaleX));
  const y = Math.max(0, Math.floor((Number(rect.y) - padY) * scaleY));
  const right = Math.min(source.width, Math.ceil((Number(rect.x) + Number(rect.width) + padX) * scaleX));
  const bottom = Math.min(source.height, Math.ceil((Number(rect.y) + Number(rect.height) + padY) * scaleY));
  if (right <= x || bottom <= y) {
    source.close();
    throw new Error("The clicked image is outside the visible page. Scroll it into view and try Alt+R again.");
  }
  const maxDimension = 2200;
  const shrink = Math.min(1, maxDimension / Math.max(right - x, bottom - y));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round((right - x) * shrink)), Math.max(1, Math.round((bottom - y) * shrink)));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    source.close();
    throw new Error("Could not process the clicked image region.");
  }
  context.drawImage(source, x, y, right - x, bottom - y, 0, 0, canvas.width, canvas.height);
  source.close();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
  if (blob.size > 5 * 1024 * 1024) throw new Error("The captured image is too large to send safely. Try zooming in and capturing a smaller area.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

async function requestAnswer({ mode, question, options, hasFiles, passages, imageDataUrl = "", customInstructions = "", signal }) {
  const { apiKey = "", model = "deeprelay/deepseek-v4.1-flash" } = await chrome.storage.local.get(["apiKey", "model"]);
  if (!apiKey.trim()) throw new Error("Add your Deep Relay API key in the extension settings first.");
  if (!MODEL_IDS.has(model)) throw new Error("Choose a supported model in the extension settings.");
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey.trim()}` },
    body: JSON.stringify({
      model,
      messages: buildAnswerMessages({ mode, question, options, hasFiles, passages, imageDataUrl, customInstructions }),
      temperature: 0.2,
      max_tokens: 700,
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer_result", strict: true, schema: answerSchema(mode) }
      }
    }),
    signal
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `Deep Relay request failed (${response.status}).`);
  const content = body?.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content.trim()
    : Array.isArray(content) ? content.map((part) => typeof part?.text === "string" ? part.text : "").join("").trim() : "";
  if (!text) throw new Error("The AI returned an empty answer. Try again.");
  let result;
  try { result = JSON.parse(text); } catch { throw new Error("The AI response was not valid JSON. Try again."); }
  if (typeof result.answer !== "string" || typeof result.explanation !== "string") throw new Error("The AI response did not contain a valid answer.");
  const validIds = new Set(options.map((option) => option.id));
  if (mode === "multiple-choice" && result.correctOptionId !== null && !validIds.has(String(result.correctOptionId))) {
    throw new Error("The AI answer did not match any detected radio choice. Try again.");
  }
  const validCitations = new Set(passages.map((passage) => `${passage.file}\u0000${passage.location}`));
  const citations = Array.isArray(result.citations)
    ? result.citations.filter((citation) => validCitations.has(`${citation.file}\u0000${citation.location}`)).slice(0, 3) : [];
  return {
    answer: result.answer.slice(0, 4000), explanation: result.explanation.slice(0, 6000),
    correctOptionId: mode === "multiple-choice" && result.correctOptionId !== null ? String(result.correctOptionId) : null,
    citations
  };
}

function answerSchema(mode) {
  return {
    type: "object", additionalProperties: false,
    properties: {
      answer: { type: "string" }, explanation: { type: "string" },
      correctOptionId: { type: ["string", "null"] }, citations: citationSchema()
    },
    required: ["answer", "explanation", "correctOptionId", "citations"]
  };
}

function citationSchema() {
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: { file: { type: "string" }, location: { type: "string" } },
      required: ["file", "location"]
    }
  };
}

function safeErrorMessage(error) {
  if (error?.name === "AbortError") return "Request cancelled.";
  return error instanceof Error ? error.message : "Answerly could not answer this question.";
}
