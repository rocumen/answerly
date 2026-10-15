# Answerly Inline

An MV3 extension that answers a highlighted question with Deep Relay AI. It injects a content script into the active tab only after a keyboard shortcut is invoked.

## Install

1. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
2. Choose **Load unpacked** and select this folder.
3. Open the Answerly Inline extension settings, paste your Deep Relay API key, choose a model, and save.
4. Highlight a question and use one of the shortcuts below. If Chrome reports a conflict, edit the shortcuts at `chrome://extensions/shortcuts`.

## Shortcuts

- **Alt+Q:** Ask the selected model to answer using nearby radio choices, select the matching radio input, and show the answer at the highlighted text's end point. It does not submit the form. If a radio group cannot be identified, an inline message explains the issue.
- **Alt+W:** Insert a written answer at the highlighted text's end point. Answer text is 55% of the question text size.
- **Alt+1:** Remove Answerly-inserted answers, status/error messages, and choice markers. It does not make an AI request or undo the selected radio value.

Click an inserted answer or choice marker to remove that item individually.

## Deep Relay configuration

The extension uses Deep Relay's OpenAI-compatible chat completions API at `https://api.deeprelay.ai/v1/chat/completions` and sends the API key as an `Authorization: Bearer` token. The popup offers these display names and canonical model IDs:

| Display name | Model ID |
| --- | --- |
| DeepSeek V4.1 Flash 0910 | `deeprelay/deepseek-v4.1-flash` |
| Kimi K3 | `deeprelay/kimi-k3` |
| GLM 5.3 | `deeprelay/glm-5.3` |
| GLM 5.3 Flash | `deeprelay/glm-5.3-flash` |

The extension uses strict JSON-schema output and validates the returned option ID against the detected radio choices before clicking a radio input.

## Data and page behavior

- The API key and model choice are stored in `chrome.storage.local` on this browser profile.
- The selected text and nearby radio-choice labels are sent directly to Deep Relay over HTTPS. The extension does not send the rest of the page.
- Answer text is inserted with DOM text nodes, not HTML markup.
- The extension does not submit forms. The Alt+Q radio selection may trigger the page's normal radio `click` and `change` handlers.
- Browser-internal pages, the Chrome Web Store, and some protected pages do not permit extension script injection.

## Files

- `manifest.json`: MV3 permissions and the three keyboard commands.
- `background.js`: command handling, cancellation, and Deep Relay chat completion requests.
- `content.js`: selection capture, nearby radio detection, answer insertion, selection, and cleanup.
- `popup.html`, `popup.css`, `popup.js`: API-key and model settings.
