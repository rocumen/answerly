(() => {
  if (globalThis.__answerlyInlineInstalled) return;
  globalThis.__answerlyInlineInstalled = true;

  const OPTION_ATTR = "data-answerly-option-id";
  const OUTPUT_ATTR = "data-answerly-output";
  const MAX_OPTIONS = 40;
  let operationNumber = 0;
  let activeOperation = 0;
  let activeRequestId = "";
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
    if (activeOperation) return;
    const selection = window.getSelection();
    const question = selection?.toString().trim();
    const focusElement = elementForNode(selection?.focusNode);
    if (!question || !focusElement) {
      showPageMessage("Highlight a question first, then use Alt+Q or Alt+W.", document.activeElement || document.body);
      return;
    }

    const anchor = findQuestionBlock(focusElement);
    const insertionPoint = makeInsertionPoint(selection);
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
    const pending = insertPageText(anchor, "Thinking…", "", insertionPoint);
    try {
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
        if (choice) {
          choice.input.click();
          if (!choice.input.checked) throw new Error("The page did not allow the radio choice to be selected.");
          addChoiceMarker(choice.element, result.answer);
        }
        setPageText(pending, formatAnswer(result), "Answer");
      } else {
        setPageText(pending, formatAnswer(result), "Answer");
      }
    } catch (error) {
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
    }
  }

  function clearOutput() {
    operationNumber += 1;
    const requestId = activeRequestId;
    activeOperation = 0;
    activeRequestId = "";
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

  function addChoiceMarker(element, answer) {
    const marker = document.createElement("span");
    marker.setAttribute(OUTPUT_ATTR, "choice-marker");
    marker.setAttribute("role", "note");
    marker.textContent = `  ✓ Selected: ${answer}`;
    marker.title = "Click to remove this answer marker";
    copyTextStyle(element, marker);
    applyAnswerColor(marker);
    marker.style.fontWeight = "bold";
    marker.style.cursor = "pointer";
    marker.addEventListener("click", () => marker.remove(), { once: true });
    element.append(marker);
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
