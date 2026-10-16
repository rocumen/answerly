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
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type });
  } catch (error) {
    console.warn("Answerly could not reach this page. Some browser pages block extensions.", error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
  const { apiKey = "", model = "deeprelay/deepseek-v4.1-flash" } = await chrome.storage.local.get(["apiKey", "model"]);
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

async function requestAnswer({ mode, question, options, hasFiles, passages, imageDataUrl = "", signal }) {
  const { apiKey = "", model = "deeprelay/deepseek-v4.1-flash", answerInstructions = "" } = await chrome.storage.local.get(["apiKey", "model", "answerInstructions"]);
  if (!apiKey.trim()) throw new Error("Add your Deep Relay API key in the extension settings first.");
  if (!MODEL_IDS.has(model)) throw new Error("Choose a supported model in the extension settings.");
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey.trim()}` },
    body: JSON.stringify({
      model,
      messages: buildAnswerMessages({ mode, question, options, hasFiles, passages, imageDataUrl, customInstructions: answerInstructions }),
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
