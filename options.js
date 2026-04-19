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
