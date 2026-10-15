const MODEL_IDS = [
  "deeprelay/deepseek-v4.1-flash",
  "deeprelay/kimi-k3",
  "deeprelay/glm-5.3",
  "deeprelay/glm-5.3-flash"
];
const keyInput = document.getElementById("api-key");
const modelSelect = document.getElementById("model");
const status = document.getElementById("status");

chrome.storage.local.get({ apiKey: "", model: MODEL_IDS[0] }).then((settings) => {
  keyInput.value = settings.apiKey;
  modelSelect.value = MODEL_IDS.includes(settings.model) ? settings.model : MODEL_IDS[0];
}).catch(() => {
  status.textContent = "Could not load saved settings.";
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
    await chrome.storage.local.set({ apiKey, model: modelSelect.value });
    status.textContent = "Settings saved on this device.";
  } catch {
    status.textContent = "Could not save settings.";
  }
});
