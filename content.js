;(function () {
  "use strict";

  console.log('[Content Script] Auto Scorer v6.1 (Skip No-Response) Loaded.');

  let uiInjected = false;
  let autoGradeAll = {
    isRunning: false,
  };
  let answerUpdateRetryTimeout = null;
  let messageId = 0;
  const pendingPromises = {};
  let mainContentObserver = null;

  const STORAGE_KEY = 'autoScorerCheckerConfig';

  // ---------------------------------------------------------------------------
  // Messaging with sandbox
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'toggle_ui') {
      if (request.enabled) {
        observeAndInject();
      } else {
        if (mainContentObserver) mainContentObserver.disconnect();
        const scorerBox = document.getElementById('autoScorerBox');
        if (scorerBox) scorerBox.remove();
        const sandbox = document.getElementById('scorer-sandbox');
        if (sandbox) sandbox.remove();
        uiInjected = false;
      }
      sendResponse({ status: 'ok' });
    }
    return true;
  });

  window.addEventListener('message', event => {
    const data = event.data;
    if (data.id !== undefined && pendingPromises[data.id]) {
      const promise = pendingPromises[data.id];
      if (data.success) {
        promise.resolve(data.score);
      } else {
        console.error("Error in sandboxed code:", data.error);
        promise.reject(new Error(data.error));
      }
      delete pendingPromises[data.id];
    }
  });

  function calculateScoreSafely(userFuncCode, answerForScoring) {
    return new Promise((resolve, reject) => {
      const sandbox = document.getElementById('scorer-sandbox');
      if (!sandbox || !sandbox.contentWindow) {
        return reject(new Error("Sandbox is not available."));
      }
      const currentId = messageId++;
      pendingPromises[currentId] = { resolve, reject };
      setTimeout(() => {
        if (pendingPromises[currentId]) {
          pendingPromises[currentId].reject(new Error("Sandbox execution timed out."));
          delete pendingPromises[currentId];
        }
      }, 5000);

      sandbox.contentWindow.postMessage({
        userCode: userFuncCode,
        studentAnswer: answerForScoring,
        id: currentId
      }, '*');
    });
  }

  // ---------------------------------------------------------------------------
  // DOM helpers for UI building
  // ---------------------------------------------------------------------------

  function createKeywordInputGroup(labelText, inputId, placeholder, isPoints = false, value = "") {
    const group = document.createElement("div");
    group.className = 'as-input-group';
    const label = document.createElement("label");
    label.innerText = labelText;
    label.htmlFor = inputId;
    const input = document.createElement("input");
    input.type = isPoints ? "number" : "text";
    input.id = inputId;
    input.placeholder = placeholder;
    input.value = value;
    if (isPoints) input.step = "any";
    group.append(label, input);
    return group;
  }

  function createCheckbox(labelText, id, isChecked = false) {
    const group = document.createElement("div");
    group.className = 'as-checkbox-group';
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = id;
    checkbox.checked = isChecked;
    label.append(checkbox, document.createTextNode(labelText));
    group.appendChild(label);
    return group;
  }

  // ---------------------------------------------------------------------------
  // Core scoring utility
  // ---------------------------------------------------------------------------

  function setScore(score) {
    const scoreInput = document.querySelector('input[type="number"][class*="ReactiveTextInput__StyledInput"]');
    if (!scoreInput) {
      console.error("[Auto Scorer] The correct score input box was not found.");
      return;
    }
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    nativeInputValueSetter.call(scoreInput, score);
    const inputEvent = new Event('input', { bubbles: true });
    const changeEvent = new Event('change', { bubbles: true });
    scoreInput.dispatchEvent(inputEvent);
    scoreInput.dispatchEvent(changeEvent);
  }

  function updateStudentAnswerPromise(attempt = 1) {
    return new Promise((resolve, reject) => {
      const checkAnswer = (currentAttempt) => {
        if (answerUpdateRetryTimeout) clearTimeout(answerUpdateRetryTimeout);
        const previewEl = document.getElementById("as-studentAnswerPreview");
        const statusEl = document.getElementById("as-studentAnswerStatus");
        if (!previewEl || !statusEl) return reject("UI not found");

        // Check for "No response" element first
        const noRespEl = document.querySelector('div[class*="ResultsSelectedItemSidebarAnswers__NoResponseDiv"]');
        if (noRespEl) {
          previewEl.textContent = "No response";
          statusEl.textContent = "Student has not answered.";
          statusEl.style.color = "#ff6600";
          statusEl.style.opacity = "1";
          resolve();
          return;
        }

        const studentResponseContent = document.querySelector('div[class*="AnswerContent__DisplayedAnswer"]');
        if (studentResponseContent) {
          previewEl.textContent = studentResponseContent.innerText.trim();
          statusEl.textContent = "Answer loaded.";
          statusEl.style.color = "var(--as-success-color)";
          statusEl.style.opacity = "1";
          resolve();
        } else if (currentAttempt < 10) {
          statusEl.textContent = `Waiting for answer...`;
          statusEl.style.color = "var(--as-warning-color)";
          statusEl.style.opacity = "1";
          answerUpdateRetryTimeout = setTimeout(() => checkAnswer(currentAttempt + 1), 300);
        } else {
          previewEl.textContent = "Could not find student answer.";
          statusEl.textContent = "Failed to load answer.";
          statusEl.style.color = "var(--as-danger-color)";
          statusEl.style.opacity = "1";
          reject("Failed to load answer");
        }
      };
      checkAnswer(attempt);
    });
  }

  // ---------------------------------------------------------------------------
  // Simple/Advanced checker model
  // ---------------------------------------------------------------------------

  function getDefaultCheckerCode() {
    return `function checkAnswer(studentAnswer) {
  let score = 0;
  const maxScore = 100;
  const answerStr = String(studentAnswer || '').toLowerCase();
  const numMatches = answerStr.match(/-?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?/g) || [];
  const answerNums = numMatches.map(s => parseFloat(s.replace(/,/g, '')));
  const answerNum = answerNums.length ? answerNums[0] : NaN;
  return score;
}`;
  }

  function serializeSimpleConfig(root) {
    const basePoints = parseFloat(root.querySelector('#as-basePoints')?.value || '0') || 0;
    const noneKeywords = root.querySelector('#as-noneKeywords')?.value || '';
    const caseSensitive = !!root.querySelector('#as-caseSensitive')?.checked;
    const trimWhitespace = !!root.querySelector('#as-trimWhitespace')?.checked;

    const conditions = [];
    root.querySelectorAll('.as-condition-row').forEach(row => {
      const keywords = row.querySelector('.as-keywords-input')?.value || '';
      const points = parseFloat(row.querySelector('.as-points-input')?.value || '0') || 0;
      const logic = row.querySelector('.as-logic-select')?.value || 'OR';
      if (!keywords.trim()) return;
      conditions.push({ keywords, points, logic });
    });

    return { basePoints, noneKeywords, caseSensitive, trimWhitespace, conditions };
  }

  function buildSimpleUIFromConfig(root, config) {
    const cfg = config || {};
    const basePointsEl = root.querySelector('#as-basePoints');
    const noneKeywordsEl = root.querySelector('#as-noneKeywords');
    const caseSensitiveEl = root.querySelector('#as-caseSensitive');
    const trimWhitespaceEl = root.querySelector('#as-trimWhitespace');
    const conditionsContainer = root.querySelector('#as-conditions-container');

    if (basePointsEl) basePointsEl.value = (cfg.basePoints != null ? cfg.basePoints : 0);
    if (noneKeywordsEl) noneKeywordsEl.value = cfg.noneKeywords || '';
    if (caseSensitiveEl) caseSensitiveEl.checked = !!cfg.caseSensitive;
    if (trimWhitespaceEl) trimWhitespaceEl.checked = cfg.trimWhitespace !== false;

    conditionsContainer.innerHTML = '';
    if (cfg.conditions && cfg.conditions.length) {
      cfg.conditions.forEach(cond => {
        const row = addConditionRow(conditionsContainer, false);
        row.querySelector('.as-keywords-input').value = cond.keywords || '';
        row.querySelector('.as-points-input').value = cond.points != null ? cond.points : 1;
        row.querySelector('.as-logic-select').value = cond.logic || 'OR';
      });
    } else {
      addConditionRow(conditionsContainer, false);
    }
  }

  function generateCodeFromSimpleConfig(config) {
    const {
      basePoints = 0,
      noneKeywords = '',
      caseSensitive = false,
      trimWhitespace = true,
      conditions = []
    } = config || {};

    const escape = (str) => String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    let code = `function checkAnswer(studentAnswer) {
  let answer = String(studentAnswer ?? '');
  ${trimWhitespace ? 'answer = answer.trim();\n  ' : ''}${!caseSensitive ? 'answer = answer.toLowerCase();\n' : ''}
  let score = ${Number(basePoints) || 0};
  const maxScore = 100;
`;

    if (noneKeywords && noneKeywords.trim()) {
      const parts = noneKeywords.split(',').map(k => k.trim()).filter(Boolean);
      if (parts.length) {
        const conditionsExpr = parts
          .map(k => `answer.includes('${escape(caseSensitive ? k : k.toLowerCase())}')`)
          .join(' || ');
        code += `
  if (${conditionsExpr}) {
    return 0;
  }
`;
      }
    }

    conditions.forEach(cond => {
      const keywords = (cond.keywords || '').split(',').map(k => k.trim()).filter(Boolean);
      if (!keywords.length) return;
      const points = Number(cond.points) || 0;
      const logic = cond.logic === 'AND' ? ' && ' : ' || ';

      const condExpr = keywords
        .map(k => `answer.includes('${escape(caseSensitive ? k : k.toLowerCase())}')`)
        .join(logic);

      code += `
  if (${condExpr}) {
    score += ${points};
  }
`;
    });

    code += `
  return score;
}`;
    return code;
  }

  let checkerState = {
    mode: 'simple',
    code: '',
    simpleConfig: null,
    advancedEdited: false,
  };

  function refreshAdvancedTextareaFromState(root) {
    const textarea = root.querySelector('#as-advancedCode');
    if (!textarea) return;
    textarea.value = checkerState.code || getDefaultCheckerCode();
  }

  function updateCodeFromSimpleUI(root, { alsoUpdateAdvancedIfNotEdited = true } = {}) {
    const cfg = serializeSimpleConfig(root);
    checkerState.simpleConfig = cfg;
    const newCode = generateCodeFromSimpleConfig(cfg);
    checkerState.code = newCode;

    const advancedTextarea = root.querySelector('#as-advancedCode');
    if (alsoUpdateAdvancedIfNotEdited && !checkerState.advancedEdited && advancedTextarea) {
      advancedTextarea.value = newCode;
    }
  }

  function initCheckerFromStorage(root) {
    chrome.storage.sync.get(STORAGE_KEY, data => {
      const stored = data[STORAGE_KEY];
      if (!stored) {
        checkerState.mode = 'simple';
        checkerState.simpleConfig = serializeSimpleConfig(root);
        checkerState.code = generateCodeFromSimpleConfig(checkerState.simpleConfig);
        checkerState.advancedEdited = false;
        refreshAdvancedTextareaFromState(root);
        return;
      }

      checkerState.mode = stored.mode || 'simple';
      checkerState.code = stored.code || getDefaultCheckerCode();
      checkerState.simpleConfig = stored.simpleConfig || null;
      checkerState.advancedEdited = !!stored.advancedEdited;

      if (checkerState.simpleConfig) {
        buildSimpleUIFromConfig(root, checkerState.simpleConfig);
      } else {
        const conditionsContainer = root.querySelector('#as-conditions-container');
        if (conditionsContainer && !conditionsContainer.children.length) {
          addConditionRow(conditionsContainer, false);
        }
      }

      refreshAdvancedTextareaFromState(root);
      applyModeVisualState(root);
    });
  }

  function persistCheckerState() {
    chrome.storage.sync.set({
      [STORAGE_KEY]: {
        mode: checkerState.mode,
        code: checkerState.code,
        simpleConfig: checkerState.simpleConfig,
        advancedEdited: checkerState.advancedEdited
      }
    });
  }

  function applyModeVisualState(root) {
    // Visual state already handled by tab clicks
    refreshAdvancedTextareaFromState(root);
  }

  // ---------------------------------------------------------------------------
  // Helper: advance to next student (used after scoring and for no-response)
  // ---------------------------------------------------------------------------
  async function goToNextStudent() {
    // 1. Find and click the NEXT STUDENT button (not next question)
    let nextBtn = null;
    const icons = document.querySelectorAll('i.material-icons-outlined');
    for (const icon of icons) {
      if (icon.textContent.trim() === 'keyboard_arrow_right') {
        const tileParent = icon.closest('[class*="Tile__RootDiv-sc-1ej5agu-0"]');
        if (tileParent && tileParent.className.includes('transparentBg')) {
          nextBtn = icon;
          break;
        }
      }
    }
    let buttonToClick = nextBtn
      ? nextBtn.closest('[class*="Tile__RootDiv-sc-1ej5agu-0"]')
      : null;
    if (!buttonToClick) {
      buttonToClick = document.querySelector('[title="Next Student"]') ||
                      document.querySelector('[aria-label*="next student" i]');
    }

    if (!buttonToClick) {
      throw new Error("Next button not found.");
    }

    buttonToClick.click();

    // 2. Wait for the new student's answer to appear
    await new Promise((resolve, reject) => {
      let checks = 0;
      const maxChecks = 40;   // 40 * 250ms = 10 seconds
      const interval = setInterval(() => {
        const answerEl = document.querySelector('div[class*="AnswerContent__DisplayedAnswer"]');
        const noRespEl = document.querySelector('div[class*="ResultsSelectedItemSidebarAnswers__NoResponseDiv"]');
        if (answerEl || noRespEl) {
          clearInterval(interval);
          resolve();
        }
        if (++checks >= maxChecks) {
          clearInterval(interval);
          reject(new Error("Timeout waiting for next student answer to load."));
        }
      }, 250);
    });

    // 3. Update preview
    await updateStudentAnswerPromise();
  }

  // ---------------------------------------------------------------------------
  // Process current student
  // ---------------------------------------------------------------------------
  async function processCurrentStudent(andGoNext = false) {
    const root = document.getElementById('autoScorerBox');
    if (!root) {
      return Promise.reject("UI not found");
    }

    // Check for "No response" before doing anything else
    const noResponseEl = document.querySelector('div[class*="ResultsSelectedItemSidebarAnswers__NoResponseDiv"]');
    if (noResponseEl) {
      console.log("[Auto Scorer] No response from student, skipping scoring.");
      if (andGoNext) {
        try {
          await goToNextStudent();
        } catch (err) {
          console.error("[Auto Scorer] Failed to advance past no-response:", err);
          return Promise.reject(err);
        }
      }
      return Promise.resolve();
    }

    const advancedTextarea = root.querySelector('#as-advancedCode');

    if (checkerState.mode === 'simple') {
      updateCodeFromSimpleUI(root, { alsoUpdateAdvancedIfNotEdited: !checkerState.advancedEdited });
    } else {
      if (advancedTextarea) {
        checkerState.code = advancedTextarea.value || getDefaultCheckerCode();
      } else {
        checkerState.code = getDefaultCheckerCode();
      }
    }

    persistCheckerState();

    const userFuncCode = checkerState.code;
    if (!userFuncCode || !userFuncCode.trim().startsWith("function")) {
      console.error("[Auto Scorer] Invalid scoring function.");
      return Promise.reject("Invalid scoring function.");
    }
    const answerForScoring = document.getElementById("as-studentAnswerPreview")?.textContent ?? "";

    try {
      const scoreValue = await calculateScoreSafely(userFuncCode, answerForScoring);
      setScore(parseFloat(scoreValue) || 0);

      if (andGoNext) {
        await goToNextStudent();
      }
      return Promise.resolve();
    } catch (err) {
      console.error("[Auto Scorer] Failed to score student:", err);
      return Promise.reject(err);
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-grade loop
  // ---------------------------------------------------------------------------
  async function startAutoGradeAll() {
    if (autoGradeAll.isRunning) return;

    const studentCountInput = document.getElementById('as-studentCount');
    const studentCount = parseInt(studentCountInput.value, 10);
    if (isNaN(studentCount) || studentCount <= 0) {
      alert("Please enter a valid number of students to grade.");
      studentCountInput.focus();
      return;
    }

    autoGradeAll.isRunning = true;
    const btn = document.getElementById("as-autoGradeButton");
    btn.textContent = "Stop";
    btn.classList.add('as-danger');
    const progressEl = document.getElementById('as-autoGradeProgress');

    for (let i = 0; i < studentCount; i++) {
      if (!autoGradeAll.isRunning) {
        progressEl.textContent = `Stopped by user.`;
        break;
      }
      progressEl.textContent = `Grading student ${i + 1} of ${studentCount}...`;

      try {
        await processCurrentStudent(true);
        const speed = document.getElementById('as-speedSetting').value || 1000;
        if (i < studentCount - 1) {
          await new Promise(resolve => setTimeout(resolve, parseInt(speed)));
        }
      } catch (error) {
        progressEl.textContent = `Error on student ${i + 1}. Stopping.`;
        stopAutoGradeAll();
        return;
      }
    }

    stopAutoGradeAll();
    progressEl.textContent = `Finished grading all ${studentCount} students.`;
  }

  function stopAutoGradeAll() {
    autoGradeAll.isRunning = false;
    const btn = document.getElementById("as-autoGradeButton");
    btn.textContent = "Auto Grade All";
    btn.classList.remove('as-danger');
  }

  // ---------------------------------------------------------------------------
  // Simple tab condition rows
  // ---------------------------------------------------------------------------
  let conditionCount = 0;

  function addConditionRow(container, focusOnNew = true) {
    conditionCount++;
    const row = document.createElement('div');
    row.className = 'as-condition-row';

    const keywordsGroup = createKeywordInputGroup("Keywords (comma-separated)", `as-keywords-${conditionCount}`, "e.g., keyword1, keyword2");
    keywordsGroup.querySelector('input').className = 'as-keywords-input';

    const logicPointsGroup = document.createElement('div');
    logicPointsGroup.className = 'as-grid';
    logicPointsGroup.style.gridTemplateColumns = '1fr 90px 30px';
    logicPointsGroup.style.gap = '8px';
    logicPointsGroup.style.alignItems = 'end';

    const logicGroup = document.createElement('div');
    logicGroup.className = 'as-input-group';
    logicGroup.innerHTML = `<label>Logic</label><select id="as-logic-${conditionCount}" class="as-logic-select"><option value="OR">ANY (OR)</option><option value="AND">ALL (AND)</option></select>`;

    const pointsGroup = createKeywordInputGroup("Points", `as-points-${conditionCount}`, "", true, "1");
    pointsGroup.querySelector('input').className = 'as-points-input';

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '–';
    removeBtn.className = 'as-button as-danger';
    removeBtn.style.padding = '8px';
    removeBtn.onclick = () => {
      row.remove();
      const root = document.getElementById('autoScorerBox');
      if (root && checkerState.mode === 'simple') {
        updateCodeFromSimpleUI(root);
        persistCheckerState();
      }
    };

    logicPointsGroup.append(logicGroup, pointsGroup, removeBtn);
    row.append(keywordsGroup, logicPointsGroup);

    row.querySelectorAll('input, select').forEach(el => {
      el.addEventListener('input', () => {
        const root = document.getElementById('autoScorerBox');
        if (!root || checkerState.mode !== 'simple') return;
        updateCodeFromSimpleUI(root);
        persistCheckerState();
      });
    });

    container.appendChild(row);
    if (focusOnNew) {
      const input = row.querySelector('.as-keywords-input');
      if (input) input.focus();
    }
    return row;
  }

  // ---------------------------------------------------------------------------
  // Main UI injection
  // ---------------------------------------------------------------------------
  function injectUI() {
    if (uiInjected) return;

    try {
      if (!document.getElementById('scorer-sandbox')) {
        const iframe = document.createElement('iframe');
        iframe.id = 'scorer-sandbox';
        iframe.src = chrome.runtime.getURL('sandbox.html');
        iframe.style.display = 'none';
        document.body.appendChild(iframe);
      }

      const box = document.createElement("div");
      box.id = "autoScorerBox";

      const style = document.createElement('style');
      style.textContent = `
        #autoScorerBox {
          --as-primary-color: #007bff; --as-primary-hover: #0056b3;
          --as-danger-color: #dc3545; --as-danger-hover: #c82333;
          --as-success-color: #28a745; --as-warning-color: #ffc107;
          --as-text-color: #212529; --as-bg-light: #f8f9fa; --as-bg-medium: #e9ecef;
          --as-border-color: #dee2e6;

          position: fixed; top: 100px; left: 20px; width: 400px;
          background-color: white; border: 1px solid var(--as-border-color);
          border-radius: 12px; box-shadow: 0 5px 20px rgba(0,0,0,0.1);
          z-index: 9999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          font-size: 14px; color: var(--as-text-color); display: flex; flex-direction: column;
        }
        #as-header {
          padding: 10px 16px; background-image: linear-gradient(to bottom, #fff, var(--as-bg-light));
          border-bottom: 1px solid var(--as-border-color); cursor: move;
          font-weight: 600; border-radius: 11px 11px 0 0; display: flex; justify-content: space-between; align-items: center;
        }
        #as-header .as-header-buttons button { background: none; border: none; cursor: pointer; padding: 4px; opacity: 0.6; font-size: 16px; }
        #as-header .as-header-buttons button:hover { opacity: 1; }
        .as-content-wrapper { padding: 0 16px 16px 16px; }
        .as-tabs { display: flex; margin-bottom: 16px; border-bottom: 1px solid var(--as-border-color); }
        .as-tab { flex: 1; text-align: center; padding: 12px 8px; border: none; background: transparent; cursor: pointer; font-weight: 500; color: #6c757d; border-bottom: 3px solid transparent; transition: all 0.2s; }
        .as-tab:hover { background-color: var(--as-bg-light); }
        .as-tab.active { font-weight: 700; color: var(--as-primary-color); border-bottom-color: var(--as-primary-color); }
        .as-tab-content { display: none; }
        .as-tab-content.active { display: block; animation: fadeIn 0.3s; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
        details.as-accordion { border: 1px solid var(--as-border-color); border-radius: 8px; margin-bottom: 10px; background-color: #fff; }
        details.as-accordion[open] { border-color: #b9cde2; }
        details.as-accordion summary { user-select: none; cursor: pointer; padding: 12px; font-weight: 600; list-style: none; display: flex; justify-content: space-between; align-items: center; background-color: #fafbfc; }
        details.as-accordion[open] summary { border-bottom: 1px solid var(--as-border-color); border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
        details.as-accordion summary .as-summary-title { display: flex; align-items: center; gap: 8px; }
        details.as-accordion summary .as-summary-icon { font-style: normal; }
        details.as-accordion summary::after { content: '›'; font-size: 20px; transition: transform 0.2s; transform: rotate(90deg); }
        details.as-accordion[open] summary::after { transform: rotate(-90deg); }
        .as-details-content { padding: 12px; }
        .as-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .as-condition-row { margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px dashed var(--as-border-color); }
        .as-condition-row:last-child { border-bottom: none; }
        .as-input-group label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 4px; color: #495057; }
        .as-input-group input, .as-input-group select { width: 100%; padding: 8px; font-size: 13px; border: 1px solid var(--as-border-color); border-radius: 6px; box-sizing: border-box; }
        .as-checkbox-group label { display: flex; align-items: center; font-size: 13px; }
        .as-checkbox-group input { margin-right: 8px; }
        #as-advancedCode { width: 100%; height: 200px; font-family: monospace; font-size: 12px; box-sizing: border-box; }
        .as-action-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .as-button { width: 100%; padding: 10px; font-size: 14px; font-weight: 600; border-radius: 8px; border: 1px solid #ced4da; background-color: #fff; color: var(--as-text-color); cursor: pointer; transition: all 0.2s; }
        .as-button:hover { background-color: var(--as-bg-light); border-color: #adb5bd; }
        .as-button:active, .as-button:disabled { transform: scale(0.98); background-color: var(--as-bg-medium); }
        .as-button:disabled { opacity: 0.6; cursor: not-allowed; }
        .as-button.as-primary { background-color: var(--as-primary-color); color: white; border-color: var(--as-primary-color); }
        .as-button.as-primary:hover { background-color: var(--as-primary-hover); }
        .as-button.as-danger { background-color: var(--as-danger-color); color: white; border-color: var(--as-danger-color); }
        .as-button.as-danger:hover { background-color: var(--as-danger-hover); }
        #as-studentAnswerPreview { white-space: pre-wrap; word-break: break-word; max-height: 60px; overflow-y: auto; border: 1px solid var(--as-bg-medium); padding: 8px; background: var(--as-bg-light); border-radius: 4px; }
        #as-studentAnswerStatus { font-size: 11px; text-align: center; margin-top: 4px; opacity: 0; transition: opacity 0.3s; height: 14px; }
        #as-autoGradeProgress { font-size: 12px; text-align: center; margin-top: 8px; height: 16px; font-weight: 500; }
        .as-settings-grid { display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; align-items: center; }
      `;
      box.appendChild(style);

      const header = document.createElement('div');
      header.id = 'as-header';
      header.innerHTML = `<span>Auto Scorer v6.1</span><div class="as-header-buttons"><button id="as-resetPosButton" title="Reset Position">📍</button><button id="as-saveButton" title="Save Checker">💾</button><button id="as-loadButton" title="Load Checker">📂</button></div>`;

      const contentWrapper = document.createElement('div');
      contentWrapper.className = 'as-content-wrapper';

      const tabs = document.createElement('div');
      tabs.className = 'as-tabs';
      tabs.innerHTML = `<button class="as-tab active" data-tab="simple">Simple</button><button class="as-tab" data-tab="number">Number</button><button class="as-tab" data-tab="advanced">Advanced</button>`;

      const simpleContent = document.createElement('div');
      simpleContent.id = 'as-simple-content';
      simpleContent.className = 'as-tab-content active';

      const numberContent = document.createElement('div');
      numberContent.id = 'as-number-content';
      numberContent.className = 'as-tab-content';
      numberContent.innerHTML = `<p>Number and unit checking is coming soon!</p>`;

      const advancedContent = document.createElement('div');
      advancedContent.id = 'as-advanced-content';
      advancedContent.className = 'as-tab-content';
      advancedContent.innerHTML = `<textarea id="as-advancedCode" placeholder="function checkAnswer(studentAnswer) { ... }"></textarea>`;

      const conditionsAccordion = document.createElement('details');
      conditionsAccordion.className = 'as-accordion';
      conditionsAccordion.open = true;
      conditionsAccordion.innerHTML = `<summary><div class="as-summary-title"><span class="as-summary-icon">🎯</span>Conditions</div></summary><div class="as-details-content"><div id="as-conditions-container"></div><button id="as-add-condition" class="as-button" style="width: 100%; margin-top: 8px;">+ Add Condition</button></div>`;

      const noneKeywordsAccordion = document.createElement('details');
      noneKeywordsAccordion.className = 'as-accordion';
      noneKeywordsAccordion.innerHTML = `<summary><div class="as-summary-title"><span class="as-summary-icon" style="color:var(--as-danger-color)">✗</span>Disqualifying Keywords</div></summary><div class="as-details-content" id="as-none-keywords-container"></div>`;

      const generalSettingsAccordion = document.createElement('details');
      generalSettingsAccordion.className = 'as-accordion';
      generalSettingsAccordion.innerHTML = `<summary><div class="as-summary-title"><span class="as-summary-icon">⚙️</span>General Settings</div></summary><div class="as-details-content" id="as-general-settings-container"></div>`;

      simpleContent.append(conditionsAccordion, noneKeywordsAccordion, generalSettingsAccordion);

      const previewAccordion = document.createElement('details');
      previewAccordion.id = 'as-preview-details';
      previewAccordion.className = 'as-accordion';
      previewAccordion.open = true;
      previewAccordion.innerHTML = `<summary><div class="as-summary-title"><span class="as-summary-icon">👁️</span>Student Answer</div></summary><div class="as-details-content"><pre id="as-studentAnswerPreview"></pre><div id="as-studentAnswerStatus"></div><button id="as-refreshAnswer" class="as-button" style="width: 100%; margin-top: 8px;">Refresh Answer</button></div>`;

      const actionButtons = document.createElement('div');
      actionButtons.className = 'as-action-buttons';
      actionButtons.innerHTML = `<button id="as-scoreButton" class="as-button">Score</button><button id="as-scoreNextButton" class="as-button as-primary">Score & Next</button>`;

      const autogradeAccordion = document.createElement('details');
      autogradeAccordion.id = 'as-autograde-details';
      autogradeAccordion.className = 'as-accordion';
      autogradeAccordion.open = true;
      autogradeAccordion.innerHTML = `<summary><div class="as-summary-title"><span class="as-summary-icon">🤖</span>Auto Grade</div></summary><div class="as-details-content"><div class="as-settings-grid"><label for="as-studentCount">Students to Grade:</label><input type="number" id="as-studentCount" value="5" min="1" /></div><div class="as-settings-grid"><label for="as-speedSetting">Speed (ms):</label><input type="number" id="as-speedSetting" value="1000" min="100" step="100" /></div><button id="as-autoGradeButton" class="as-button as-primary" style="width: 100%; margin-top: 8px;">Auto Grade All</button><div id="as-autoGradeProgress"></div></div>`;

      contentWrapper.append(tabs, simpleContent, numberContent, advancedContent, previewAccordion, actionButtons, autogradeAccordion);
      box.append(header, contentWrapper);

      const noneKeywordsContainer = noneKeywordsAccordion.querySelector("#as-none-keywords-container");
      noneKeywordsContainer.append(createKeywordInputGroup("Keywords (comma-separated)", "as-noneKeywords", "e.g., incorrect, wrong"));

      const generalSettingsContainer = generalSettingsAccordion.querySelector("#as-general-settings-container");
      generalSettingsContainer.append(
        createKeywordInputGroup("Base Points", "as-basePoints", "", true, "0"),
        createCheckbox("Case Sensitive", "as-caseSensitive", false),
        createCheckbox("Trim Whitespace", "as-trimWhitespace", true)
      );

      document.body.appendChild(box);

      box.querySelectorAll('#as-basePoints, #as-noneKeywords, #as-caseSensitive, #as-trimWhitespace').forEach(el => {
        el.addEventListener('input', () => {
          if (checkerState.mode !== 'simple') return;
          updateCodeFromSimpleUI(box);
          persistCheckerState();
        });
      });

      const conditionsContainer = box.querySelector('#as-conditions-container');
      box.querySelector('#as-add-condition').onclick = () => addConditionRow(conditionsContainer);

      box.querySelectorAll('.as-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          box.querySelectorAll('.as-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          box.querySelectorAll('.as-tab-content').forEach(c => c.classList.remove('active'));
          box.querySelector(`#as-${tab.dataset.tab}-content`).classList.add('active');
          if (tab.dataset.tab === 'simple') checkerState.mode = 'simple';
          else if (tab.dataset.tab === 'advanced') checkerState.mode = 'advanced';
          persistCheckerState();
        });
      });

      const advancedTextarea = box.querySelector('#as-advancedCode');
      advancedTextarea.addEventListener('input', () => {
        const trimmedNow = advancedTextarea.value.trim();
        const generatedFromSimple = checkerState.simpleConfig
          ? generateCodeFromSimpleConfig(checkerState.simpleConfig).trim()
          : '';
        checkerState.code = advancedTextarea.value;
        checkerState.advancedEdited = (trimmedNow !== generatedFromSimple);
        persistCheckerState();
      });

      box.querySelector('#as-refreshAnswer').onclick = () => updateStudentAnswerPromise().catch(err => console.error(err));

      box.querySelector('#as-scoreButton').onclick = async () => {
        const btn = box.querySelector('#as-scoreButton');
        btn.textContent = 'Scoring...'; btn.disabled = true;
        await processCurrentStudent(false).catch(err => console.error("Scoring failed:", err));
        btn.disabled = false; btn.textContent = 'Score';
      };

      box.querySelector('#as-scoreNextButton').onclick = async () => {
        const btn = box.querySelector('#as-scoreNextButton');
        btn.textContent = 'Scoring...'; btn.disabled = true;
        await processCurrentStudent(true).catch(err => console.error("Scoring & Next failed:", err));
        btn.disabled = false; btn.textContent = 'Score & Next';
      };

      box.querySelector('#as-autoGradeButton').onclick = () => {
        if (autoGradeAll.isRunning) stopAutoGradeAll();
        else startAutoGradeAll();
      };

      box.querySelector('#as-saveButton').onclick = () => {
        persistCheckerState();
        alert('Checker configuration saved to browser storage.');
      };

      box.querySelector('#as-loadButton').onclick = () => {
        initCheckerFromStorage(box);
        alert('Checker configuration reloaded from browser storage.');
      };

      box.querySelector('#as-resetPosButton').onclick = () => {
        box.style.top = '100px'; box.style.left = '20px';
      };

      let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
      header.onmousedown = (e) => {
        e.preventDefault();
        pos3 = e.clientX; pos4 = e.clientY;
        document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; };
        document.onmousemove = (e) => {
          e.preventDefault();
          pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY;
          pos3 = e.clientX; pos4 = e.clientY;
          box.style.top = (box.offsetTop - pos2) + "px";
          box.style.left = (box.offsetLeft - pos1) + "px";
        };
      };

      const initialConditionsContainer = box.querySelector('#as-conditions-container');
      if (initialConditionsContainer && !initialConditionsContainer.children.length) {
        addConditionRow(initialConditionsContainer, false);
      }

      checkerState.mode = 'simple';
      checkerState.simpleConfig = serializeSimpleConfig(box);
      checkerState.code = generateCodeFromSimpleConfig(checkerState.simpleConfig);
      checkerState.advancedEdited = false;
      refreshAdvancedTextareaFromState(box);

      initCheckerFromStorage(box);

      uiInjected = true;
      console.log("[Auto Scorer] UI Injected Successfully.");
    } catch (error) {
      console.error("[Auto Scorer] CRITICAL ERROR during UI Injection:", error);
      alert("A critical error occurred while building the Auto Scorer UI. Check the console for details.");
    }
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------
  function observeAndInject() {
    if (document.getElementById('autoScorerBox')) return;
    const targetSelector = 'div[class^="ResultsSelectedItemSidebarAnswers"]';
    const observer = new MutationObserver((mutations, obs) => {
      if (document.querySelector(targetSelector)) {
        injectUI();
        obs.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    mainContentObserver = observer;
  }

  chrome.storage.sync.get('scorerEnabled', ({ scorerEnabled }) => {
    if (scorerEnabled) {
      observeAndInject();
    }
  });

})();
