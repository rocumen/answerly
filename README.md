# Answerly Inline

An MV3 extension that answers highlighted questions with Deep Relay AI and can ground answers in locally stored study modules.

## Build and install

1. Install Node.js 22.13 or later.
2. In this folder, run `npm install` and `npm run build`. The build packages PDF.js and its worker/font data into `vendor/`; no CDN is used by the extension.
3. Open `chrome://extensions` in Chrome and enable **Developer mode**.
4. Choose **Load unpacked** and select this folder.
5. Open Answerly Inline’s toolbar popup, add a Deep Relay API key, choose a model, and optionally attach study files.
6. Edit the **Answer focus prompt** if you want to change what the AI prioritizes or how it phrases responses. Highlight a question and use one of the shortcuts below. Edit conflicts at `chrome://extensions/shortcuts`.

## Shortcuts

- **Alt+Q:** Use nearby radio options, select a supported best answer, show a concise answer at the highlighted text’s endpoint, and add a marker by the selected option. It does not submit the form. If evidence does not support a choice, the model may return no selection.
- **Alt+W:** Insert a concise written answer at the highlighted text’s endpoint. Answer text defaults to 60% of the question’s font size; adjust it from 40% to 100% in the popup. Its color matches the question by default, and can be customized there.
- **Alt+R:** Start image-question capture, then click the visible image or question area. Answerly takes a screenshot crop around that click, reads it with a vision model, and inserts the answer after the clicked image’s block. Press **Escape** before clicking to cancel.
- **Alt+1:** Remove Answerly-inserted answers, status/error messages, citations, and choice markers. It does not make an AI request or undo a selected radio value.

Click an inserted answer or choice marker to remove that item individually.
Inserted text no longer includes a keyboard-shortcut reminder; use **Alt+1** to clear Answerly content. The popup’s answer color setting also applies to choice markers.

## Study files

Attach files by dropping them in the popup area or choosing them with the file picker. Supported formats are PDF, DOCX, PPTX, TXT, and Markdown. The limit is 10 files, 20 MB per file, and 300,000 extracted characters per file. Text-only PDF pages are supported; scanned image-only pages need OCR and may not yield readable text.

Files are parsed locally when attached. The extension stores extracted text in extension IndexedDB; original file bytes are not retained. It selects up to five question-relevant excerpts (up to 8,000 characters total) and sends those excerpts with the highlighted question only when Alt+Q or Alt+W is invoked. Citations use the attached filename plus page, slide, paragraph, or heading location. Uploaded document content is treated as reference data, not as instructions.

Remove files individually in the popup or use **Clear all files**. Attachments remain on this browser profile until removed or the extension is uninstalled.

## Answers and research

The popup’s **Answer focus prompt** lets you set a personal preference, such as asking for a definition, a short explanation, or a particular subject emphasis. It starts with a concise-answer default, is saved locally, and is sent with each question request. Fixed instructions still require accurate answers, evidence rules, no hidden reasoning, and the expected structured response. Attached module excerpts are the only factual source when files are present; returned citations are validated against the excerpts actually sent.

Deep Relay’s documented inference API does not provide hosted web search. With no files attached, Answerly answers from the selected model’s existing knowledge and does not claim live research. For current facts, use a separate browser search and attach relevant material if you want it cited by this extension.

For Alt+R image answers, select a vision-capable chat model. In the current Deep Relay image-input documentation, the compatible models among Answerly’s catalog are **Kimi K3** (`deeprelay/kimi-k3`) and **GLM 5.3 Flash** (`deeprelay/glm-5.3-flash`). Alt+R captures the visible tab locally and crops around the clicked element; only that crop and nearby page text are sent to Deep Relay. Avoid clicking an image if the visible area contains unrelated private information. Image input incurs model input usage. Some browser-internal, protected, cross-origin frame, video, or offscreen content cannot be captured this way.

## Deep Relay configuration

The extension uses Deep Relay’s OpenAI-compatible chat completions API at `https://api.deeprelay.ai/v1/chat/completions` with `Authorization: Bearer` authentication. Models:

| Display name | Model ID |
| --- | --- |
| DeepSeek V4.1 Flash 0910 | `deeprelay/deepseek-v4.1-flash` (text in chat image mode) |
| Kimi K3 | `deeprelay/kimi-k3` (vision) |
| GLM 5.3 | `deeprelay/glm-5.3` |
| GLM 5.3 Flash | `deeprelay/glm-5.3-flash` (vision) |

## Data and page behavior

- The API key, selected model, and custom answer-focus prompt are stored in `chrome.storage.local`.
- Attached extracted text and the answer-focus prompt stay local until a shortcut requests an answer. Relevant excerpts, question text, and nearby radio-choice labels are then sent to Deep Relay over HTTPS.
- The extension injects a content script into the active tab only after a shortcut. It uses DOM text nodes and never submits forms.
- Alt+R temporarily listens for the next page click after you invoke it. The screenshot is cropped locally around that clicked area and only the crop is sent to Deep Relay; the extension does not save screenshots.
- Alt+Q’s radio click may trigger the page’s regular radio `click` and `change` handlers.
- Browser-internal pages, the Chrome Web Store, and some protected pages block extension script injection.

## Development checks

- `npm run build` builds the local file parser bundle.
- `npm test` checks extraction for PDF, DOCX, PPTX, TXT, and Markdown, local passage retrieval, and prompt safeguards.
