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

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "ANSWERLY_CLEAR_OUTPUT") {
      clearOutput();
      return;
    }
    if (message?.type === "ANSWERLY_MULTIPLE_CHOICE") answerSelection("multiple-choice");
    if (message?.type === "ANSWERLY_WORDS") answerSelection("words");
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
        if (!choice) throw new Error("The returned answer did not match a radio option on the page.");
        choice.input.click();
        if (!choice.input.checked) throw new Error("The page did not allow the radio choice to be selected.");
        addChoiceMarker(choice.element, result.answer);
        const explanation = result.explanation ? ` ${result.explanation}` : "";
        setPageText(pending, `${result.answer}${explanation}`, "Answer");
      } else {
        const explanation = result.explanation ? ` ${result.explanation}` : "";
        setPageText(pending, `${result.answer}${explanation}`, "Answer");
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
    document.querySelectorAll(`[${OUTPUT_ATTR}]`).forEach((node) => node.remove());
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
    copyTextStyle(anchor, node, 0.55);
    node.style.whiteSpace = "pre-wrap";
    node.style.display = "block";
    node.style.width = "100%";
    node.style.cursor = "pointer";
    node.style.opacity = "0.9";
    node.textContent = `${label ? `${label}: ` : ""}${text}  (Alt+1 to remove)`;
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
    node.textContent = `${label ? `${label}: ` : ""}${text}  (Alt+1 to remove)`;
  }

  function addChoiceMarker(element, answer) {
    const marker = document.createElement("span");
    marker.setAttribute(OUTPUT_ATTR, "choice-marker");
    marker.setAttribute("role", "note");
    marker.textContent = `  ✓ Selected: ${answer} (Alt+1 to remove)`;
    marker.title = "Click to remove this answer marker";
    copyTextStyle(element, marker);
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

  function showPageMessage(message, anchor) {
    const node = insertPageText(findQuestionBlock(elementForNode(anchor) || document.body), message, "Answerly");
    node.setAttribute("aria-live", "polite");
  }
})();
