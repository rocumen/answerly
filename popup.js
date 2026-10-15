import { extractStudyFile, MAX_FILE_COUNT, MAX_FILE_BYTES } from "./vendor/file-parser.js";
import { listStudyFiles, saveStudyFile, removeStudyFile, clearStudyFiles } from "./study-store.js";

const MODEL_IDS = [
  "deeprelay/deepseek-v4.1-flash",
  "deeprelay/kimi-k3",
  "deeprelay/glm-5.3",
  "deeprelay/glm-5.3-flash"
];
const DEFAULT_ANSWER_INSTRUCTIONS = "Answer exactly what the question asks. Be direct and concise. For multiple choice, choose only from the provided options. If the evidence is insufficient, say so briefly instead of guessing. Avoid unrelated details.";
const keyInput = document.getElementById("api-key");
const modelSelect = document.getElementById("model");
const answerInstructionsInput = document.getElementById("answer-instructions");
const status = document.getElementById("status");
const fileInput = document.getElementById("file-input");
const dropZone = document.getElementById("drop-zone");
const fileList = document.getElementById("study-files");
const fileStatus = document.getElementById("file-status");
const clearFilesButton = document.getElementById("clear-files");
let processingFiles = false;

chrome.storage.local.get({ apiKey: "", model: MODEL_IDS[0], answerInstructions: DEFAULT_ANSWER_INSTRUCTIONS }).then((settings) => {
  keyInput.value = settings.apiKey;
  modelSelect.value = MODEL_IDS.includes(settings.model) ? settings.model : MODEL_IDS[0];
  answerInstructionsInput.value = typeof settings.answerInstructions === "string"
    ? settings.answerInstructions.slice(0, 2000)
    : DEFAULT_ANSWER_INSTRUCTIONS;
}).catch(() => {
  status.textContent = "Could not load saved settings.";
});

renderFiles().catch(() => {
  fileStatus.textContent = "Could not load attached files.";
});

document.getElementById("save").addEventListener("click", async () => {
  const apiKey = keyInput.value.trim();
  if (!apiKey) {
    status.textContent = "Enter your Deep Relay API key to save settings.";
    keyInput.focus();
    return;
  }
  if (!MODEL_IDS.includes(modelSelect.value)) {
    status.textContent = "Choose one of the listed models.";
    modelSelect.focus();
    return;
  }
  try {
    await chrome.storage.local.set({
      apiKey,
      model: modelSelect.value,
      answerInstructions: answerInstructionsInput.value.trim().slice(0, 2000) || DEFAULT_ANSWER_INSTRUCTIONS
    });
    status.textContent = "Settings saved on this device.";
  } catch {
    status.textContent = "Could not save settings.";
  }
});

fileInput.addEventListener("change", () => processFiles(fileInput.files));
dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
});
dropZone.addEventListener("dragleave", (event) => {
  if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove("dragging");
});
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  processFiles(event.dataTransfer?.files);
});
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});

clearFilesButton.addEventListener("click", async () => {
  try {
    await clearStudyFiles();
    await renderFiles();
    fileStatus.textContent = "All module files removed from this device.";
  } catch {
    fileStatus.textContent = "Could not clear the local file library.";
  }
});

async function processFiles(fileCollection) {
  const files = [...(fileCollection || [])];
  fileInput.value = "";
  if (!files.length || processingFiles) return;
  processingFiles = true;
  let saved = 0;
  try {
    for (const file of files) {
      const current = await listStudyFiles();
      if (current.length >= MAX_FILE_COUNT) throw new Error(`You can attach up to ${MAX_FILE_COUNT} files.`);
      if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 20 MB.`);
      fileStatus.textContent = `Reading ${file.name} locally…`;
      const extracted = await extractStudyFile(file);
      await saveStudyFile(extracted);
      saved += 1;
      await renderFiles();
    }
    fileStatus.textContent = saved ? `${saved} file${saved === 1 ? "" : "s"} extracted and saved on this device.` : "No files added.";
  } catch (error) {
    fileStatus.textContent = error instanceof Error ? error.message : "Could not read that file.";
    await renderFiles().catch(() => {});
  } finally {
    processingFiles = false;
  }
}

async function renderFiles() {
  const files = await listStudyFiles();
  fileList.replaceChildren();
  for (const file of files) {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${file.name} · ${file.sections.length} text sections`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.addEventListener("click", async () => {
      try {
        await removeStudyFile(file.id);
        await renderFiles();
        fileStatus.textContent = `${file.name} removed.`;
      } catch {
        fileStatus.textContent = "Could not remove that file.";
      }
    });
    row.append(name, remove);
    fileList.append(row);
  }
  clearFilesButton.hidden = files.length === 0;
}
