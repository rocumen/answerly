const API_URL = "https://api.deeprelay.ai/v1/chat/completions";
const MODEL_IDS = new Set([
  "deeprelay/deepseek-v4.1-flash",
  "deeprelay/kimi-k3",
  "deeprelay/glm-5.3",
  "deeprelay/glm-5.3-flash"
]);
const MAX_QUESTION_CHARS = 12000;
const MAX_OPTIONS = 40;
const activeRequests = new Map();

chrome.commands.onCommand.addListener(async (command) => {
  const commandTypes = {
    "answer-multiple-choice": "ANSWERLY_MULTIPLE_CHOICE",
    "answer-in-words": "ANSWERLY_WORDS",
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
  const { apiKey = "", model = "deeprelay/deepseek-v4.1-flash" } = await chrome.storage.local.get(["apiKey", "model"]);
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
          correctOptionId: { type: "string" }
        },
        required: ["answer", "explanation", "correctOptionId"]
      }
    : {
        type: "object",
        additionalProperties: false,
        properties: {
          answer: { type: "string" },
          explanation: { type: "string" },
          correctOptionId: { type: ["string", "null"] }
        },
        required: ["answer", "explanation", "correctOptionId"]
      };
  const instruction = mode === "multiple-choice"
    ? "Solve the highlighted question. Select the single best answer from the supplied radio choices. Return its exact option id. Do not invent an option id."
    : "Answer the highlighted question in concise, clear words. Use nearby choices as context if provided. Do not return an option id.";
  const prompt = [
    instruction,
    `Highlighted question/context:\n${question}`,
    `Nearby radio choices (JSON):\n${JSON.stringify(options)}`
  ].join("\n\n");

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey.trim()}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
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
  if (mode === "multiple-choice" && !validIds.has(String(result.correctOptionId))) {
    throw new Error("The AI answer did not match any detected radio choice. Try again.");
  }
  return {
    answer: result.answer.slice(0, 4000),
    explanation: result.explanation.slice(0, 6000),
    correctOptionId: mode === "multiple-choice" ? String(result.correctOptionId) : null
  };
}

function safeErrorMessage(error) {
  if (error?.name === "AbortError") return "Request cancelled.";
  return error instanceof Error ? error.message : "Answerly could not answer this question.";
}
