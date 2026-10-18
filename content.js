(() => {
  // The worker injects this file on demand for each shortcut; avoid registering duplicate listeners.
  if (globalThis.__answerlyInlineInstalled) return;
  globalThis.__answerlyInlineInstalled = true;

  const OPTION_ATTR = "data-answerly-option-id";
  const OUTPUT_ATTR = "data-answerly-output";
  const MAX_OPTIONS = 40;
  let operationNumber = 0;
  let activeOperation = 0;
  let selectionCapturePending = false;
  let activeRequestId = "";
  let activeEditorStatusToken = "";
  let activeContentEditableStatus = null;
  let activeOptions = [];
  let answerFontScale = 0.6;
  let answerUsePageColor = true;
  let answerCustomColor = "#333333";
  let imageCaptureArmed = false;
  let imageClickHandler = null;
  let imageKeyHandler = null;

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "ANSWERLY_CLEAR_OUTPUT") {
      clearOutput();
      return;
    }
    if (message?.type === "ANSWERLY_ARM_IMAGE_CAPTURE") armImageCapture();
    if (message?.type === "ANSWERLY_MULTIPLE_CHOICE") answerSelection("multiple-choice");
    if (message?.type === "ANSWERLY_WORDS") answerSelection("words");
  });

  chrome.storage.local.get({ answerFontScale: 0.6, answerUsePageColor: true, answerCustomColor: "#333333" }).then((settings) => {
    const savedScale = settings.answerFontScale;
    const scale = Number(savedScale);
    if (Number.isFinite(scale)) answerFontScale = Math.max(0.4, Math.min(1, scale));
    answerUsePageColor = settings.answerUsePageColor !== false;
    if (isValidHexColor(settings.answerCustomColor)) answerCustomColor = settings.answerCustomColor;
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.answerFontScale) {
      const scale = Number(changes.answerFontScale.newValue);
      if (Number.isFinite(scale)) answerFontScale = Math.max(0.4, Math.min(1, scale));
    }
    if (changes.answerUsePageColor) answerUsePageColor = changes.answerUsePageColor.newValue !== false;
    if (changes.answerCustomColor && isValidHexColor(changes.answerCustomColor.newValue)) {
      answerCustomColor = changes.answerCustomColor.newValue;
    }
  });

  async function answerSelection(mode) {
    if (activeOperation || selectionCapturePending) return;
    selectionCapturePending = true;
    const directEditableSelection = captureEditableSelection();
    let editableSelection;
    try {
      editableSelection = directEditableSelection || await capturePageEditorSelection();
    } finally {
      selectionCapturePending = false;
    }
    const selection = window.getSelection();
    const question = (editableSelection?.text || selection?.toString() || "").trim();
    const focusElement = editableSelection?.element || elementForNode(selection?.focusNode);
    if (!question || !focusElement) {
      showPageMessage("Highlight a question first, then use Alt+Q or Alt+W.", document.activeElement || document.body);
      return;
    }

    const anchor = findQuestionBlock(focusElement);
    const insertionPoint = editableSelection ? null : makeInsertionPoint(selection);
    const options = mode === "multiple-choice" ? findRadioOptions(anchor) : findNearbyContextOptions(anchor);
    if (mode === "multiple-choice" && options.length < 2) {
      showPageMessage("No multiple-choice radio options were found near this question.", anchor);
      return;
    }

    const operationId = ++operationNumber;
    const requestId = `answerly-${Date.now()}-${operationId}`;
    activeOperation = operationId;
    activeRequestId = requestId;
    activeOptions = options;
    // Keep loading text outside an editable control so it never becomes part of the user's text.
    const pending = insertPageText(anchor, "Thinking…", "", insertionPoint);
    try {
      if (mode === "words" && editableSelection?.type === "page-editor") {
        activeEditorStatusToken = editableSelection.token;
        const status = await chrome.runtime.sendMessage({
          type: "ANSWERLY_SHOW_EDITOR_STATUS",
          token: editableSelection.token
        }).catch(() => null);
        if (activeOperation !== operationId) {
          await finishEditorStatus(editableSelection.token, "");
          return;
        }
        if (status?.shown) pending.remove();
      } else if (mode === "words" && editableSelection?.type === "contenteditable") {
        activeContentEditableStatus = showContentEditableStatus(editableSelection);
        if (activeContentEditableStatus) pending.remove();
      }
      const response = await chrome.runtime.sendMessage({
        type: "ANSWERLY_ANSWER_REQUEST",
        requestId,
        payload: {
          mode,
          question,
          options: options.map(({ id, text }) => ({ id, text }))
        }
      });
      if (activeOperation !== operationId) return;
      if (!response?.ok) throw new Error(response?.error || "Could not get an answer.");
      const result = response.result;

      if (mode === "multiple-choice") {
        const choice = options.find((option) => option.id === result.correctOptionId);
        if (result.correctOptionId !== null && !choice) throw new Error("The returned answer did not match a radio option on the page.");
        await completeAnswer(pending, formatAnswer(result), editableSelection);
      } else {
        await completeAnswer(pending, formatAnswer(result), editableSelection);
      }
    } catch (error) {
      if (editableSelection?.type === "page-editor" && activeEditorStatusToken === editableSelection.token) {
        await finishEditorStatus(editableSelection.token, "");
        activeEditorStatusToken = "";
      }
      if (activeContentEditableStatus) {
        finishContentEditableStatus(activeContentEditableStatus, "");
        activeContentEditableStatus = null;
      }
      if (activeOperation === operationId && error?.name !== "AbortError") {
        pending.textContent = `Answerly: ${error.message || "Something went wrong."} (click to dismiss)`;
        pending.setAttribute("aria-live", "polite");
      } else {
        pending.remove();
      }
    } finally {
      restoreOptionAttributes(options);
      if (activeOperation === operationId) {
        activeOperation = 0;
        activeRequestId = "";
        activeOptions = [];
      }
      if (editableSelection?.type === "page-editor" && activeEditorStatusToken === editableSelection.token) {
        activeEditorStatusToken = "";
      }
      if (activeContentEditableStatus?.selection === editableSelection) activeContentEditableStatus = null;
    }
  }

  function clearOutput() {
    operationNumber += 1;
    const requestId = activeRequestId;
    const statusToken = activeEditorStatusToken;
    const contentEditableStatus = activeContentEditableStatus;
    activeOperation = 0;
    activeRequestId = "";
    activeEditorStatusToken = "";
    activeContentEditableStatus = null;
    if (statusToken) finishEditorStatus(statusToken, "");
    if (contentEditableStatus) finishContentEditableStatus(contentEditableStatus, "");
    if (requestId) {
      chrome.runtime.sendMessage({ type: "ANSWERLY_CANCEL_REQUEST", requestId }).catch(() => {});
    }
    restoreOptionAttributes(activeOptions);
    activeOptions = [];
    disarmImageCapture();
    document.querySelectorAll(`[${OUTPUT_ATTR}]`).forEach((node) => node.remove());
  }

  function armImageCapture() {
    if (activeOperation || imageCaptureArmed) return;
    imageCaptureArmed = true;
    // Alt+R arms one click; the page itself remains interactive and no image is sent before that click.
    imageClickHandler = (event) => {
      if (event.target?.closest?.(`[${OUTPUT_ATTR}]`)) return;
      disarmImageCapture();
      const clicked = elementForNode(event.target);
      if (!clicked) return;
      const visual = clicked.closest("img,canvas,svg,[role='img'],picture") || clicked;
      const rect = visual.getBoundingClientRect();
      const pointRect = {
        x: rect.width > 0 ? rect.left : event.clientX - 280,
        y: rect.height > 0 ? rect.top : event.clientY - 180,
        width: rect.width > 0 ? rect.width : 560,
        height: rect.height > 0 ? rect.height : 360
      };
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const anchor = findQuestionBlock(visual);
      const pending = insertPageText(anchor, "Reading image…", "Answerly");
      const operationId = ++operationNumber;
      const requestId = `answerly-image-${Date.now()}-${operationId}`;
      activeOperation = operationId;
      activeRequestId = requestId;
      chrome.runtime.sendMessage({
        type: "ANSWERLY_IMAGE_REQUEST",
        requestId,
        payload: {
          question: nearbyQuestionContext(visual),
          imageRect: pointRect,
          viewport
        }
      }).then((response) => {
        if (activeOperation !== operationId) return;
        if (!response?.ok) throw new Error(response?.error || "Could not answer the image.");
        setPageText(pending, formatAnswer(response.result), "Answer");
      }).catch((error) => {
        if (activeOperation === operationId && error?.name !== "AbortError") {
          pending.textContent = `Answerly: ${error.message || "Could not answer the image."} (click to dismiss)`;
          pending.setAttribute("aria-live", "polite");
        } else {
          pending.remove();
        }
      }).finally(() => {
        if (activeOperation === operationId) {
          activeOperation = 0;
          activeRequestId = "";
        }
      });
    };
    imageKeyHandler = (event) => {
      if (event.key !== "Escape") return;
      disarmImageCapture();
    };
    document.addEventListener("click", imageClickHandler, true);
    document.addEventListener("keydown", imageKeyHandler, true);
  }

  function disarmImageCapture() {
    imageCaptureArmed = false;
    if (imageClickHandler) document.removeEventListener("click", imageClickHandler, true);
    if (imageKeyHandler) document.removeEventListener("keydown", imageKeyHandler, true);
    imageClickHandler = null;
    imageKeyHandler = null;
    if (!activeRequestId) activeOperation = 0;
  }

  function nearbyQuestionContext(element) {
    const block = findQuestionBlock(element);
    let text = (block?.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length < 40 && block?.parentElement) {
      text = (block.parentElement.innerText || text).replace(/\s+/g, " ").trim();
    }
    return text.slice(0, 5000) || "Read the question shown in the captured image and answer it.";
  }

  function elementForNode(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function captureEditableSelection() {
    const active = document.activeElement;
    if (isTextControl(active) && active.selectionStart !== null && active.selectionEnd > active.selectionStart) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      return {
        type: "text-control",
        element: active,
        start,
        end,
        text: active.value.slice(start, end)
      };
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const focusElement = elementForNode(selection.focusNode);
    const root = editableRootFor(focusElement);
    if (!root || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const text = range.toString();
    return text.trim() ? { type: "contenteditable", element: root, range, text } : null;
  }

  function isTextControl(element) {
    if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
    if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly) return false;
    return ["text", "search", "url", "tel", "email", "number"].includes(element.type);
  }

  function editableRootFor(element) {
    let root = null;
    for (let current = element; current?.isContentEditable; current = current.parentElement) root = current;
    return root;
  }

  async function capturePageEditorSelection() {
    const token = `answerly-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const response = await chrome.runtime.sendMessage({ type: "ANSWERLY_GET_EDITOR_SELECTION", token });
      if (!response?.ok || !response.selection?.text) return null;
      return {
        type: "page-editor",
        element: document.activeElement,
        token,
        text: String(response.selection.text)
      };
    } catch {
      return null;
    }
  }

  async function completeAnswer(pending, answerText, editableSelection) {
    if (activeContentEditableStatus?.selection === editableSelection) {
      const status = activeContentEditableStatus;
      activeContentEditableStatus = null;
      if (finishContentEditableStatus(status, answerText)) {
        pending.remove();
        return;
      }
    }
    if (editableSelection?.type === "page-editor") {
      try {
        if (activeEditorStatusToken === editableSelection.token) {
          const response = await finishEditorStatus(editableSelection.token, answerText);
          activeEditorStatusToken = "";
          if (response?.replaced) {
            pending.remove();
            return;
          }
        }
        const response = await chrome.runtime.sendMessage({
          type: "ANSWERLY_REPLACE_EDITOR_SELECTION",
          token: editableSelection.token,
          text: answerText
        });
        if (response?.ok && response.replaced) {
          pending.remove();
          return;
        }
      } catch {
        // If the editor changed while the answer was generated, preserve the answer inline.
      }
    } else if (editableSelection && insertAfterEditableSelection(editableSelection, answerText)) {
      pending.remove();
      return;
    }
    setPageText(pending, answerText, "Answer");
  }

  function finishEditorStatus(token, text) {
    return chrome.runtime.sendMessage({
      type: "ANSWERLY_FINISH_EDITOR_STATUS",
      token,
      text
    }).catch(() => null);
  }

  function showContentEditableStatus(target) {
    const root = target?.element;
    const editor = root?.closest?.(".cm-editor");
    if (!root?.isConnected || !editor || !root.matches(".cm-content")) return null;
    if (!(document.activeElement === root || root.contains(document.activeElement) || root.matches(":focus-within"))) return null;

    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const currentRange = selection.getRangeAt(0);
    if (currentRange.toString() !== target.text) return null;
    try {
      if (target.range.compareBoundaryPoints(Range.START_TO_START, currentRange) !== 0 ||
          target.range.compareBoundaryPoints(Range.END_TO_END, currentRange) !== 0) return null;
    } catch {
      return null;
    }

    const editorLabel = `${editor.innerText.slice(0, 300)} ${document.title}`;
    const comment = /\.py\b|python/i.test(editorLabel) ? "#" : "//";
    const marker = `${comment} Thinking…`;
    const insertionText = editorInsertionText(target.text, marker);
    const insertionRange = currentRange.cloneRange();
    insertionRange.collapse(false);
    selection.removeAllRanges();
    selection.addRange(insertionRange);
    if (!document.execCommand("insertText", false, insertionText)) return null;

    const markerLine = [...root.querySelectorAll(".cm-line")].find((line) => line.textContent === marker);
    return markerLine ? { selection: target, root, marker, markerLine } : null;
  }

  function finishContentEditableStatus(status, replacementText) {
    const { root, marker } = status || {};
    if (!root?.isConnected) return false;
    const markerLine = [...root.querySelectorAll(".cm-line")].find((line) => line.textContent === marker);
    if (!markerLine) return false;
    const range = document.createRange();
    range.selectNodeContents(markerLine);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const replacement = replacementText ? String(replacementText) : "";
    return document.execCommand("insertText", false, replacement);
  }

  function insertAfterEditableSelection(target, answerText) {
    if (!target?.element?.isConnected || !answerText) return false;
    if (target.type === "text-control") {
      const control = target.element;
      if (document.activeElement !== control || control.disabled || control.readOnly) return false;
      if (control.value.slice(target.start, target.end) !== target.text) return false;
      const suffix = control instanceof HTMLTextAreaElement
        ? editorInsertionText(target.text, answerText)
        : `  ${answerText}`;
      control.setRangeText(suffix, target.end, target.end, "end");
      dispatchInput(control, suffix);
      return true;
    }

    const root = target.element;
    if (!root.isContentEditable || !(document.activeElement === root || root.contains(document.activeElement))) return false;
    const range = target.range;
    if (!range?.startContainer?.isConnected || !range.endContainer?.isConnected || range.toString() !== target.text) return false;
    const currentSelection = window.getSelection();
    if (!currentSelection?.rangeCount) return false;
    const currentRange = currentSelection.getRangeAt(0);
    try {
      if (range.compareBoundaryPoints(Range.START_TO_START, currentRange) !== 0 ||
          range.compareBoundaryPoints(Range.END_TO_END, currentRange) !== 0) return false;
    } catch {
      return false;
    }

    // Collapse to the selection's end so the original highlighted text remains untouched.
    const insertionRange = currentRange.cloneRange();
    insertionRange.collapse(false);
    currentSelection.removeAllRanges();
    currentSelection.addRange(insertionRange);
    const insertionText = editorInsertionText(target.text, answerText);
    // execCommand lets many rich-text and contenteditable editors handle the edit natively.
    if (document.execCommand("insertText", false, insertionText)) return true;
    const inserted = document.createTextNode(insertionText);
    insertionRange.insertNode(inserted);
    insertionRange.setStartAfter(inserted);
    insertionRange.collapse(true);
    currentSelection.removeAllRanges();
    currentSelection.addRange(insertionRange);
    dispatchInput(root, insertionText);
    return true;
  }

  function editorInsertionText(selectedText, answerText) {
    const prefix = /[\r\n]$/.test(selectedText) ? "" : "\n";
    const suffix = /[\r\n]$/.test(answerText) ? "" : "\n";
    return `${prefix}${answerText}${suffix}`;
  }

  function dispatchInput(target, text) {
    let event;
    try {
      event = new InputEvent("input", { bubbles: true, inputType: "insertText", data: text });
    } catch {
      event = new Event("input", { bubbles: true });
    }
    target.dispatchEvent(event);
  }

  function makeInsertionPoint(selection) {
    if (!selection?.focusNode?.isConnected) return null;
    try {
      const range = document.createRange();
      range.setStart(selection.focusNode, selection.focusOffset);
      range.collapse(true);
      return range;
    } catch {
      return null;
    }
  }

  function findQuestionBlock(start) {
    const semanticBlocks = "p,li,td,th,blockquote,h1,h2,h3,h4,h5,h6";
    const blockTags = new Set(["P", "DIV", "LI", "TD", "TH", "BLOCKQUOTE", "SECTION", "ARTICLE", "H1", "H2", "H3", "H4", "H5", "H6"]);
    let current = start;
    let fallback = start;
    while (current && current !== document.body && current !== document.documentElement) {
      if (blockTags.has(current.tagName) || ["block", "list-item", "flex", "grid", "table"].includes(getComputedStyle(current).display)) {
        fallback = current;
        if (current.matches(semanticBlocks)) return current;
      }
      current = current.parentElement;
    }
    return fallback;
  }

  function ancestorRoots(anchor, maxDepth = 5) {
    const roots = [];
    let current = anchor;
    for (let depth = 0; current && current !== document.body && depth < maxDepth; depth += 1, current = current.parentElement) {
      if (current !== anchor) roots.push(current);
    }
    return roots;
  }

  function findRadioOptions(anchor) {
    for (const root of ancestorRoots(anchor)) {
      const radios = [...root.querySelectorAll('input[type="radio"]')]
        .filter((input) => !input.disabled && !input.closest(`[${OUTPUT_ATTR}]`));
      const groups = new Map();
      for (const input of radios) {
        const form = input.form || root;
        const groupName = input.name || "";
        let byName = groups.get(form);
        if (!byName) groups.set(form, byName = new Map());
        const key = groupName || input.closest('fieldset,[role="radiogroup"]') || input.parentElement;
        let group = byName.get(key);
        if (!group) byName.set(key, group = []);
        group.push(input);
      }
      const group = [...groups.values()].flatMap((byName) => [...byName.values()])
        .filter((items) => items.length >= 2)
        .sort((left, right) => right.length - left.length)[0];
      if (group) return stampOptions(group.slice(0, MAX_OPTIONS).map((input, index) => {
        const label = input.labels?.[0] || input.closest("label");
        const element = label || input.parentElement || input;
        return {
          id: String(index),
          text: radioText(input, element),
          element,
          input,
          hadId: false,
          previousId: null
        };
      }).filter((option) => option.text));
    }
    return [];
  }

  function findNearbyContextOptions(anchor) {
    for (const root of ancestorRoots(anchor)) {
      const labels = [...root.querySelectorAll('input[type="radio"]')]
        .map((input) => {
          const element = input.labels?.[0] || input.closest("label") || input.parentElement;
          return element ? radioText(input, element) : "";
        })
        .filter(Boolean);
      if (labels.length >= 2) return labels.slice(0, MAX_OPTIONS).map((text, index) => ({ id: String(index), text }));
    }
    return [];
  }

  function radioText(input, element) {
    const text = (element?.innerText || input.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
    if (text) return text.slice(0, 1000);
    const value = input.value?.trim();
    return value && value.toLowerCase() !== "on" ? value.slice(0, 1000) : "";
  }

  function stampOptions(options) {
    for (const option of options) {
      option.hadId = option.element.hasAttribute(OPTION_ATTR);
      option.previousId = option.element.getAttribute(OPTION_ATTR);
      option.element.setAttribute(OPTION_ATTR, option.id);
    }
    return options;
  }

  function restoreOptionAttributes(options) {
    for (const option of options) {
      if (!option.element?.isConnected) continue;
      if (option.hadId) option.element.setAttribute(OPTION_ATTR, option.previousId);
      else option.element.removeAttribute(OPTION_ATTR);
    }
  }

  function insertPageText(anchor, text, label, insertionPoint = null) {
    const node = document.createElement("div");
    node.setAttribute(OUTPUT_ATTR, "answer");
    node.setAttribute("role", "note");
    copyTextStyle(anchor, node, answerFontScale);
    applyAnswerColor(node);
    node.style.whiteSpace = "pre-wrap";
    node.style.display = "block";
    node.style.width = "100%";
    node.style.cursor = "pointer";
    node.style.opacity = "0.9";
    node.textContent = `${label ? `${label}: ` : ""}${text}`;
    node.title = "Click to remove this answer";
    node.addEventListener("click", () => node.remove(), { once: true });
    let insertedAtSelection = false;
    if (insertionPoint?.startContainer?.isConnected) {
      try {
        const point = insertionPoint.cloneRange();
        point.collapse(true);
        point.insertNode(node);
        insertedAtSelection = true;
      } catch {
        // Fall back to the question block if the page changed the range.
      }
    }
    if (!insertedAtSelection) {
      if (anchor?.isConnected && anchor.parentElement) anchor.insertAdjacentElement("afterend", node);
      else document.body.append(node);
    }
    return node;
  }

  function setPageText(node, text, label) {
    node.textContent = `${label ? `${label}: ` : ""}${text}`;
  }

  function formatAnswer(result) {
    const explanation = result.explanation ? ` ${result.explanation}` : "";
    const citations = Array.isArray(result.citations) && result.citations.length
      ? ` Sources: ${result.citations.map((source) => `${source.file} · ${source.location}`).join("; ")}.`
      : "";
    return `${result.answer}${explanation}${citations}`;
  }

  function copyTextStyle(source, target, fontScale = 1) {
    const style = getComputedStyle(source?.isConnected ? source : document.body);
    target.style.fontFamily = style.fontFamily;
    const computedSize = Number.parseFloat(style.fontSize);
    target.style.fontSize = Number.isFinite(computedSize) ? `${computedSize * fontScale}px` : style.fontSize;
    target.style.color = style.color;
    target.style.lineHeight = style.lineHeight;
    target.style.fontWeight = style.fontWeight;
    target.style.fontStyle = style.fontStyle;
    target.style.margin = style.margin;
    target.style.padding = style.padding;
  }

  function applyAnswerColor(node) {
    if (!answerUsePageColor && isValidHexColor(answerCustomColor)) node.style.color = answerCustomColor;
  }

  function isValidHexColor(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
  }

  function showPageMessage(message, anchor) {
    const node = insertPageText(findQuestionBlock(elementForNode(anchor) || document.body), message, "Answerly");
    node.setAttribute("aria-live", "polite");
  }
})();
