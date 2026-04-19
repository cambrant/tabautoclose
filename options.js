/* global browser */

const saveFolder = document.getElementById("saveFolder");
const statusEl = document.getElementById("status");
const importFileEl = document.getElementById("importfile");
let statusTimeoutId = null;
const OPTION_IDS = [
  "closeThreshold",
  "saveFolder",
  "closeAllMatching",
  "closeActive",
  "closeAudible",
  "closePinned",
  "debug",
  "intervalrules_url_regex",
  "intervalrules_seconds_and_container_regex",
  "ignorerules_url_regex",
  "ignorerules_container_regex",
];
const SETTINGS_INITIALIZED_KEY = "settingsInitialized";
const RULE_EDITORS = {
  close: {
    section: "close",
    rootId: "close-rules",
    addButtonId: "addrule-close",
  },
  ignoreContainer: {
    section: "ignoreContainer",
    rootId: "ignore-container-rules",
    addButtonId: "addrule-ignore-container",
  },
  ignoreUrl: {
    section: "ignoreUrl",
    rootId: "ignore-url-rules",
    addButtonId: "addrule-ignore-url",
  },
};
const ruleEditorState = {
  close: [],
  ignoreContainer: [],
  ignoreUrl: [],
  legacyIgnore: [],
};

function createEmptyCloseRule() {
  return { seconds: "", url: "", container: "", comment: "" };
}

function createEmptyIgnoreContainerRule() {
  return { container: "", comment: "" };
}

function createEmptyIgnoreUrlRule() {
  return { url: "", comment: "" };
}

function normalizeComment(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("#")) {
    return "";
  }

  return trimmed.slice(1).trim();
}

function parsePairedRuleLines(leftValue, rightValue) {
  const leftLines = leftValue === "" ? [] : leftValue.split("\n");
  const rightLines = rightValue === "" ? [] : rightValue.split("\n");
  const rowCount = Math.max(leftLines.length, rightLines.length);
  const rows = [];
  let pendingComments = [];

  for (let i = 0; i < rowCount; i++) {
    const rawLeft = leftLines[i] || "";
    const rawRight = rightLines[i] || "";
    const left = rawLeft.trim();
    const right = rawRight.trim();
    const leftIsComment = left.startsWith("#");
    const rightIsComment = right.startsWith("#");

    if (
      (leftIsComment || left === "") &&
      (rightIsComment || right === "") &&
      (leftIsComment || rightIsComment)
    ) {
      const comment = normalizeComment(left) || normalizeComment(right);
      if (comment !== "") {
        pendingComments.push(comment);
      }
      continue;
    }

    if (left === "" && right === "") {
      continue;
    }

    rows.push({
      left,
      right,
      comment: pendingComments.join(" ").trim(),
    });
    pendingComments = [];
  }

  return rows;
}

function appendCommentPair(leftLines, rightLines, comment) {
  const trimmed = comment.trim();
  if (trimmed === "") {
    return;
  }

  const commentLine = `# ${trimmed}`;
  leftLines.push(commentLine);
  rightLines.push(commentLine);
}

function parseCloseRuleRows(leftValue, rightValue) {
  return parsePairedRuleLines(leftValue, rightValue).map((row) => {
    const leftParts = row.left.split(",");
    return {
      seconds: (leftParts.shift() || "").trim(),
      container: leftParts.join(",").trim(),
      url: row.right,
      comment: row.comment,
    };
  });
}

function parseIgnoreRuleRows(leftValue, rightValue) {
  const parsed = {
    ignoreContainer: [],
    ignoreUrl: [],
    legacyIgnore: [],
  };

  parsePairedRuleLines(leftValue, rightValue).forEach((row) => {
    if (row.left !== "" && row.right === "") {
      parsed.ignoreContainer.push({
        container: row.left,
        comment: row.comment,
      });
      return;
    }

    if (row.left === "" && row.right !== "") {
      parsed.ignoreUrl.push({
        url: row.right,
        comment: row.comment,
      });
      return;
    }

    parsed.legacyIgnore.push(row);
  });

  return parsed;
}

function serializeCloseRuleRows(rows) {
  const leftLines = [];
  const rightLines = [];

  rows.forEach((row) => {
    const seconds = row.seconds.trim();
    const url = row.url.trim();
    const container = row.container.trim();
    const comment = row.comment.trim();

    if (seconds === "" && url === "" && container === "" && comment === "") {
      return;
    }

    if (seconds === "" && url === "" && container === "") {
      return;
    }

    appendCommentPair(leftLines, rightLines, comment);
    leftLines.push(`${seconds},${container}`);
    rightLines.push(url);
  });

  return {
    intervalrules_seconds_and_container_regex: leftLines.join("\n"),
    intervalrules_url_regex: rightLines.join("\n"),
  };
}

function serializeIgnoreRuleRows(containerRows, urlRows, legacyRows) {
  const leftLines = [];
  const rightLines = [];

  containerRows.forEach((row) => {
    const container = row.container.trim();
    const comment = row.comment.trim();

    if (container === "" && comment === "") {
      return;
    }

    if (container === "") {
      return;
    }

    appendCommentPair(leftLines, rightLines, comment);
    leftLines.push(container);
    rightLines.push("");
  });

  urlRows.forEach((row) => {
    const url = row.url.trim();
    const comment = row.comment.trim();

    if (url === "" && comment === "") {
      return;
    }

    if (url === "") {
      return;
    }

    appendCommentPair(leftLines, rightLines, comment);
    leftLines.push("");
    rightLines.push(url);
  });

  legacyRows.forEach((row) => {
    appendCommentPair(leftLines, rightLines, row.comment || "");
    leftLines.push(row.left || "");
    rightLines.push(row.right || "");
  });

  return {
    ignorerules_container_regex: leftLines.join("\n"),
    ignorerules_url_regex: rightLines.join("\n"),
  };
}

function ensureRuleSectionHasRow(section) {
  if (ruleEditorState[section].length === 0) {
    if (section === "close") {
      ruleEditorState.close.push(createEmptyCloseRule());
    } else if (section === "ignoreContainer") {
      ruleEditorState.ignoreContainer.push(createEmptyIgnoreContainerRule());
    } else if (section === "ignoreUrl") {
      ruleEditorState.ignoreUrl.push(createEmptyIgnoreUrlRule());
    }
  }
}

function syncRuleStorageFields() {
  const closeValues = serializeCloseRuleRows(ruleEditorState.close);
  const ignoreValues = serializeIgnoreRuleRows(
    ruleEditorState.ignoreContainer,
    ruleEditorState.ignoreUrl,
    ruleEditorState.legacyIgnore,
  );

  document.getElementById("intervalrules_seconds_and_container_regex").value =
    closeValues.intervalrules_seconds_and_container_regex;
  document.getElementById("intervalrules_url_regex").value =
    closeValues.intervalrules_url_regex;
  document.getElementById("ignorerules_container_regex").value =
    ignoreValues.ignorerules_container_regex;
  document.getElementById("ignorerules_url_regex").value =
    ignoreValues.ignorerules_url_regex;
}

function renderCloseRules() {
  const root = document.getElementById(RULE_EDITORS.close.rootId);
  root.replaceChildren();

  ruleEditorState.close.forEach((row, index) => {
    const ruleEl = document.createElement("div");
    ruleEl.className = "rule-card-close";
    ruleEl.dataset.section = "close";
    ruleEl.dataset.index = index;

    const titleEl = document.createElement("div");
    titleEl.className = "rule-card-close-title";
    titleEl.textContent = `Rule #${index + 1}`;
    ruleEl.append(titleEl);

    const fields = [
      {
        key: "seconds",
        label: "Interval",
        placeholder: "Interval (seconds)",
        inputMode: "numeric",
      },
      {
        key: "url",
        label: "URL",
        placeholder: "URL (regex)",
      },
      {
        key: "container",
        label: "Container name",
        placeholder: "Container name (regex)",
      },
      {
        key: "comment",
        label: "Comment",
        placeholder: "Comment",
      },
    ];

    fields.forEach((field) => {
      const fieldRowEl = document.createElement("div");
      fieldRowEl.className = "rule-row rule-row-close-field";
      fieldRowEl.dataset.section = "close";
      fieldRowEl.dataset.index = index;

      const label = document.createElement("label");
      label.textContent = field.label;
      fieldRowEl.append(label);

      const input = document.createElement("input");
      input.type = "text";
      input.value = row[field.key];
      input.placeholder = field.placeholder;
      input.dataset.section = "close";
      input.dataset.index = index;
      input.dataset.key = field.key;
      if (field.inputMode) {
        input.inputMode = field.inputMode;
      }
      fieldRowEl.append(input);
      ruleEl.append(fieldRowEl);
    });

    const actionsEl = document.createElement("div");
    actionsEl.className = "rule-row-close-actions";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "rule-btn";
    removeBtn.textContent = "-";
    removeBtn.dataset.section = "close";
    removeBtn.dataset.index = index;
    removeBtn.dataset.action = "remove";
    removeBtn.setAttribute("aria-label", "Remove close rule");
    actionsEl.append(removeBtn);
    ruleEl.append(actionsEl);
    root.append(ruleEl);
  });
}

function renderIgnoreRules(section) {
  const rootId =
    section === "ignoreContainer"
      ? RULE_EDITORS.ignoreContainer.rootId
      : RULE_EDITORS.ignoreUrl.rootId;
  const root = document.getElementById(rootId);
  const rows = ruleEditorState[section];
  root.replaceChildren();

  rows.forEach((row, index) => {
    const rowEl = document.createElement("div");
    rowEl.className = "rule-row rule-row-ignore";
    rowEl.dataset.section = section;
    rowEl.dataset.index = index;

    const valueField =
      section === "ignoreContainer"
        ? { key: "container", placeholder: "Container (regex)" }
        : { key: "url", placeholder: "URL (regex)" };

    [valueField, { key: "comment", placeholder: "Comment" }].forEach((field) => {
      const input = document.createElement("input");
      input.type = "text";
      input.value = row[field.key];
      input.placeholder = field.placeholder;
      input.dataset.section = section;
      input.dataset.index = index;
      input.dataset.key = field.key;
      rowEl.append(input);
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "rule-btn";
    removeBtn.textContent = "-";
    removeBtn.dataset.section = section;
    removeBtn.dataset.index = index;
    removeBtn.dataset.action = "remove";
    removeBtn.setAttribute(
      "aria-label",
      section === "ignoreContainer"
        ? "Remove ignore container rule"
        : "Remove ignore URL rule",
    );
    rowEl.append(removeBtn);
    root.append(rowEl);
  });
}

function renderRuleEditors() {
  ensureRuleSectionHasRow("close");
  ensureRuleSectionHasRow("ignoreContainer");
  ensureRuleSectionHasRow("ignoreUrl");
  renderCloseRules();
  renderIgnoreRules("ignoreContainer");
  renderIgnoreRules("ignoreUrl");
  document.getElementById("ignore-legacy-note").hidden =
    ruleEditorState.legacyIgnore.length === 0;
  syncRuleStorageFields();
}

function loadRuleEditorsFromStorageFields() {
  ruleEditorState.close = parseCloseRuleRows(
    document.getElementById("intervalrules_seconds_and_container_regex").value,
    document.getElementById("intervalrules_url_regex").value,
  );

  const parsedIgnore = parseIgnoreRuleRows(
    document.getElementById("ignorerules_container_regex").value,
    document.getElementById("ignorerules_url_regex").value,
  );
  ruleEditorState.ignoreContainer = parsedIgnore.ignoreContainer;
  ruleEditorState.ignoreUrl = parsedIgnore.ignoreUrl;
  ruleEditorState.legacyIgnore = parsedIgnore.legacyIgnore;
  renderRuleEditors();
}

function saveOptionValues(ids) {
  const data = {};
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      data[id] = getElementValue(el);
    }
  });
  data[SETTINGS_INITIALIZED_KEY] = true;
  return browser.storage.local.set(data);
}

function onRuleInput(evt) {
  const target = evt.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  const { section, key } = target.dataset;
  const index = parseInt(target.dataset.index || "", 10);
  if (!section || !key || isNaN(index) || !ruleEditorState[section]) {
    return;
  }

  ruleEditorState[section][index][key] = target.value;
  syncRuleStorageFields();
}

function onRuleChange() {
  syncRuleStorageFields();
  saveOptionValues([
    "intervalrules_seconds_and_container_regex",
    "intervalrules_url_regex",
    "ignorerules_container_regex",
    "ignorerules_url_regex",
  ])
    .then(() => showStatus(""))
    .catch((e) => {
      console.error(e);
      showStatus("Failed to save option.", true);
    });
}

function addRuleRow(section) {
  if (section === "close") {
    ruleEditorState.close.push(createEmptyCloseRule());
  } else if (section === "ignoreContainer") {
    ruleEditorState.ignoreContainer.push(createEmptyIgnoreContainerRule());
  } else if (section === "ignoreUrl") {
    ruleEditorState.ignoreUrl.push(createEmptyIgnoreUrlRule());
  }

  renderRuleEditors();
  onRuleChange();
}

function removeRuleRow(section, index) {
  ruleEditorState[section].splice(index, 1);
  ensureRuleSectionHasRow(section);
  renderRuleEditors();
  onRuleChange();
}

function onRuleClick(evt) {
  const target = evt.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  if (target.dataset.action === "remove") {
    const { section } = target.dataset;
    const index = parseInt(target.dataset.index || "", 10);
    if (!section || isNaN(index) || !ruleEditorState[section]) {
      return;
    }

    removeRuleRow(section, index);
  }
}

function recGetFolders(node, depth = 0) {
  let out = new Map();
  if (typeof node.url !== "string") {
    if (node.id !== "root________") {
      out.set(node.id, { depth: depth, title: node.title });
    }
    if (node.children) {
      for (let child of node.children) {
        out = new Map([...out, ...recGetFolders(child, depth + 1)]);
      }
    }
  }
  return out;
}

async function initSaveFolderSelect() {
  const nodes = await browser.bookmarks.getTree();
  let out = new Map();
  let depth = 1;
  for (const node of nodes) {
    out = new Map([...out, ...recGetFolders(node, depth)]);
  }
  for (const [k, v] of out) {
    saveFolder.add(new Option("-".repeat(v.depth) + " " + v.title, k));
  }
}

function getElementValue(el) {
  let value = el.type === "checkbox" ? el.checked : el.value;

  if (el.type === "number") {
    try {
      value = parseInt(value);
      if (isNaN(value)) {
        value = el.min;
      }
      if (value < el.min) {
        value = el.min;
      }
    } catch (e) {
      value = el.min;
    }
  }

  return value;
}

function showStatus(message, isError = false) {
  if (statusTimeoutId !== null) {
    clearTimeout(statusTimeoutId);
    statusTimeoutId = null;
  }

  statusEl.textContent = message;
  statusEl.style.color = isError ? "darkred" : "inherit";

  if (message !== "" && !isError) {
    statusTimeoutId = setTimeout(() => {
      statusEl.textContent = "";
      statusEl.style.color = "inherit";
      statusTimeoutId = null;
    }, 10000);
  }
}

function collectOptionsFromForm() {
  const data = {};
  OPTION_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      data[id] = getElementValue(el);
    }
  });

  return data;
}

async function saveOptions() {
  await browser.storage.local.set({
    ...collectOptionsFromForm(),
    [SETTINGS_INITIALIZED_KEY]: true,
  });
  await browser.runtime.sendMessage({ cmd: "storageChanged" });
}

async function exportOptions() {
  const config = await browser.storage.local.get(null);
  const blob = new Blob([JSON.stringify(config, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  anchor.href = url;
  anchor.download = `tabautoclose-config-${timestamp}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function applyOptionsToForm(config) {
  OPTION_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el || typeof config[id] === "undefined") {
      return;
    }

    if (el.type === "checkbox") {
      el.checked = config[id];
    } else {
      el.value = config[id];
    }
  });

  loadRuleEditorsFromStorageFields();
}

async function loadOptionsIntoForm() {
  const config = await browser.storage.local.get(OPTION_IDS);
  applyOptionsToForm(config);
}

async function importOptions(file) {
  const text = await file.text();
  const config = JSON.parse(text);

  if (config === null || Array.isArray(config) || typeof config !== "object") {
    throw new Error("Imported data must be a JSON object.");
  }

  await browser.storage.local.clear();
  await browser.storage.local.set({
    ...config,
    [SETTINGS_INITIALIZED_KEY]: true,
  });
  await browser.runtime.sendMessage({ cmd: "storageChanged" });
  await loadOptionsIntoForm();
}

function onChange(evt) {
  let id = evt.target.id;
  let el = document.getElementById(id);
  let obj = {};

  const value = getElementValue(el);
  obj[id] = value;
  obj[SETTINGS_INITIALIZED_KEY] = true;
  browser.storage.local
    .set(obj)
    .then(() => showStatus(""))
    .catch((e) => {
      console.error(e);
      showStatus("Failed to save option.", true);
    });
}

async function onLoad() {
  try {
    await initSaveFolderSelect();
  } catch (e) {
    console.error(e);
  }

  // Show "Close active tabs" only in Firefox (getBrowserInfo is Firefox-only)
  if (typeof browser.runtime.getBrowserInfo === "function") {
    document.getElementById("closeActiveLabel").hidden = false;
  }

  try {
    await loadOptionsIntoForm();
  } catch (e) {
    console.error(e);
  }

  OPTION_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("change", onChange);
    }
  });

  Object.values(RULE_EDITORS).forEach((editor) => {
    const root = document.getElementById(editor.rootId);
    root.addEventListener("input", onRuleInput);
    root.addEventListener("change", onRuleChange);
    root.addEventListener("click", onRuleClick);
    document
      .getElementById(editor.addButtonId)
      .addEventListener("click", () => addRuleRow(editor.section));
  });

  document.getElementById("savebtn").addEventListener("click", async () => {
    try {
      await saveOptions();
      showStatus("Options saved.");
    } catch (e) {
      console.error(e);
      showStatus("Failed to save options.", true);
    }
  });

  document.getElementById("exportbtn").addEventListener("click", async () => {
    try {
      await saveOptions();
      await exportOptions();
      showStatus("Configuration exported.");
    } catch (e) {
      console.error(e);
      showStatus("Failed to export configuration.", true);
    }
  });

  document.getElementById("importbtn").addEventListener("click", () => {
    importFileEl.click();
  });

  importFileEl.addEventListener("change", async (evt) => {
    const [file] = evt.target.files;
    if (!file) {
      return;
    }

    try {
      await importOptions(file);
      showStatus("Configuration imported.");
    } catch (e) {
      console.error(e);
      showStatus("Failed to import configuration.", true);
    } finally {
      importFileEl.value = "";
    }
  });
}

document.addEventListener("DOMContentLoaded", onLoad);
