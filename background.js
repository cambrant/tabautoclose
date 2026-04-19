/* global browser */

let closeThreshold = 7;
let saveFolder = "unfiled_____";
let cleanupIntervalIds = [];
let reconciliationIntervalId = null;
let autostart = false;
let closeAllMatching = false;
let closeActive = false;
let closeAudible = false;
let closePinned = false;
let debug = false;

const tabStates = new Map();
const containerNameCache = new Map();
let parsedIgnoreRules = [];
let parsedIntervalRules = [];
let runtimeStateSeeded = false;
let tabEventListenersRegistered = false;
let runtimeStarted = false;
const SETTINGS_INITIALIZED_FALLBACK_KEYS = [
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

const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

function debugLog(message, details) {
  if (!debug) {
    return;
  }

  const resolvedDetails =
    typeof details === "function" ? details() : details;

  if (typeof details === "undefined") {
    console.debug("[TabAutoClose]", message);
  } else {
    console.debug("[TabAutoClose]", message, resolvedDetails);
  }
}

function updateBadge(text, color) {
  browser.browserAction.setBadgeText({
    text,
  });
  browser.browserAction.setBadgeBackgroundColor({
    color,
  });
}

async function setToStorage(id, value) {
  let obj = {};
  obj[id] = value;
  return browser.storage.local.set(obj);
}

function coerceStoredValue(type, value) {
  if (typeof value === type) {
    return value;
  }

  if (type === "boolean" && typeof value === "string") {
    const normalizedValue = value.trim().toLowerCase();

    if (normalizedValue === "true") {
      return true;
    }
    if (normalizedValue === "false") {
      return false;
    }
  }

  if (type === "number" && typeof value === "string" && value.trim() !== "") {
    const parsedValue = parseInt(value, 10);

    if (!Number.isNaN(parsedValue)) {
      return parsedValue;
    }
  }

  return undefined;
}

async function getFromStorage(type, id, fallback) {
  let tmp = await browser.storage.local.get(id);
  const coercedValue = coerceStoredValue(type, tmp[id]);

  if (typeof coercedValue !== "undefined") {
    if (coercedValue !== tmp[id]) {
      await setToStorage(id, coercedValue);
    }

    return coercedValue;
  }

  await setToStorage(id, fallback);
  return fallback;
}

async function getDebugFromStorage() {
  const tmp = await browser.storage.local.get("debug");

  if (tmp.debug === true) {
    return true;
  }

  if (typeof tmp.debug === "string") {
    return tmp.debug.trim().toLowerCase() === "true";
  }

  return false;
}

async function getSettingsInitializedFromStorage() {
  const tmp = await browser.storage.local.get("settingsInitialized");
  const initialized = coerceStoredValue("boolean", tmp.settingsInitialized);

  if (initialized === true) {
    return true;
  }

  const legacyConfig = await browser.storage.local.get(
    SETTINGS_INITIALIZED_FALLBACK_KEYS,
  );

  return SETTINGS_INITIALIZED_FALLBACK_KEYS.some(
    (key) => typeof legacyConfig[key] !== "undefined",
  );
}

function clearCleanupIntervals() {
  cleanupIntervalIds.forEach((id) => {
    clearInterval(id);
  });
  cleanupIntervalIds = [];
}

function clearReconciliationInterval() {
  if (reconciliationIntervalId !== null) {
    clearInterval(reconciliationIntervalId);
    reconciliationIntervalId = null;
  }
}

function stopAllScheduledWork() {
  clearCleanupIntervals();
  clearReconciliationInterval();
}

function parseIgnoreRules(
  ignorerulesStr_container_regexs,
  ignorerulesStr_url_regexs,
) {
  const ignoreRules = [];
  const containerRegexes = ignorerulesStr_container_regexs.split("\n");
  const urlRegexes = ignorerulesStr_url_regexs.split("\n");

  for (let i = 0; i < containerRegexes.length && i < urlRegexes.length; i++) {
    try {
      const left = containerRegexes[i].trim();
      const right = urlRegexes[i].trim();

      if (!left.startsWith("#") && !right.startsWith("#")) {
        const containerNameMatcher = left === "" ? null : new RegExp(left);
        const urlMatcher = right === "" ? null : new RegExp(right);

        if (urlMatcher !== null) {
          ignoreRules.push({
            containerNameMatcher,
            urlMatcher,
            requiresContainerName: true,
          });
        }
      }
    } catch (e) {
      console.error(e);
    }
  }

  return ignoreRules;
}

function parseIntervalRules(
  intervalrulesStr_seconds_and_container_regexs,
  intervalrulesStr_url_regexs,
) {
  const intervalRules = [];
  const timeMsAndContainerRegexes =
    intervalrulesStr_seconds_and_container_regexs.split("\n");
  const urlRegexes = intervalrulesStr_url_regexs.split("\n");

  for (
    let i = 0;
    i < timeMsAndContainerRegexes.length && i < urlRegexes.length;
    i++
  ) {
    try {
      let left = timeMsAndContainerRegexes[i].trim();
      let right = urlRegexes[i].trim();

      if (
        !left.startsWith("#") &&
        !right.startsWith("#") &&
        right !== "" &&
        left !== ""
      ) {
        const leftParts = left.split(",");
        if (leftParts.length < 2) {
          continue;
        }

        const minIdleTimeSecondsRaw = leftParts[0].trim();
        if (!/^\d+$/.test(minIdleTimeSecondsRaw)) {
          continue;
        }

        const minIdleTimeMilliSecs = parseInt(minIdleTimeSecondsRaw, 10) * 1000;

        left = leftParts.slice(1).join(",");

        intervalRules.push({
          minIdleTimeMilliSecs,
          containerNameMatcher: left === "" ? null : new RegExp(left),
          urlMatcher: new RegExp(right),
          requiresContainerName: true,
        });
      }
    } catch (e) {
      console.error(e);
    }
  }

  return intervalRules;
}

function rulesRequireContainerNames() {
  return (
    parsedIgnoreRules.some((rule) => rule.requiresContainerName) ||
    parsedIntervalRules.some((rule) => rule.requiresContainerName)
  );
}

async function getContainerNameFromCookieStoreId(cookieStoreId) {
  if (!browser.contextualIdentities) {
    return null;
  }

  try {
    const contextualIdentity =
      await browser.contextualIdentities.get(cookieStoreId);
    return contextualIdentity.name;
  } catch (e) {
    // Not inside a named container.
  }

  return null;
}

async function getCachedContainerName(cookieStoreId) {
  if (!containerNameCache.has(cookieStoreId)) {
    containerNameCache.set(
      cookieStoreId,
      await getContainerNameFromCookieStoreId(cookieStoreId),
    );
  }

  return containerNameCache.get(cookieStoreId);
}

function buildTabState(tab) {
  const now = Date.now();
  const cookieStoreId =
    typeof tab.cookieStoreId === "string" ? tab.cookieStoreId : "";

  return {
    id: tab.id,
    windowId: tab.windowId,
    windowType: tab.windowType || "normal",
    url: typeof tab.url === "string" ? tab.url : "",
    title: typeof tab.title === "string" ? tab.title : "",
    active: tab.active === true,
    audible: tab.audible === true,
    pinned: tab.pinned === true,
    cookieStoreId,
    containerName: null,
    lastActivatedAt: tab.active
      ? now
      : typeof tab.lastAccessed === "number"
        ? tab.lastAccessed
        : now,
  };
}

function mergeTabState(existingState, patch) {
  if (!existingState) {
    return {
      id: patch.id,
      windowId: patch.windowId,
      windowType: patch.windowType,
      url: patch.url || "",
      title: patch.title || "",
      active: patch.active === true,
      audible: patch.audible === true,
      pinned: patch.pinned === true,
      cookieStoreId: patch.cookieStoreId || "",
      containerName:
        typeof patch.containerName === "undefined" ? null : patch.containerName,
      lastActivatedAt:
        typeof patch.lastActivatedAt === "number" ? patch.lastActivatedAt : 0,
    };
  }

  const nextState = { ...existingState };

  Object.keys(patch).forEach((key) => {
    if (typeof patch[key] !== "undefined") {
      nextState[key] = patch[key];
    }
  });

  return nextState;
}

function upsertTabState(tab, patch = {}) {
  if (typeof tab.id !== "number") {
    return null;
  }

  const existingState = tabStates.get(tab.id);
  const nextState = existingState
    ? mergeTabState(existingState, {
        id: tab.id,
        windowId: tab.windowId,
        windowType: tab.windowType || "normal",
        url: typeof tab.url === "string" ? tab.url : "",
        title: typeof tab.title === "string" ? tab.title : "",
        active: tab.active === true,
        audible: tab.audible === true,
        pinned: tab.pinned === true,
        cookieStoreId:
          typeof tab.cookieStoreId === "string" ? tab.cookieStoreId : "",
        ...patch,
      })
    : mergeTabState(null, {
        ...buildTabState(tab),
        ...patch,
      });

  if (
    existingState &&
    nextState.cookieStoreId !== existingState.cookieStoreId &&
    typeof patch.containerName === "undefined"
  ) {
    nextState.containerName = null;
  }

  tabStates.set(tab.id, nextState);
  debugLog(existingState ? "State entry updated" : "State entry created", {
    id: nextState.id,
    windowId: nextState.windowId,
    windowType: nextState.windowType,
    url: nextState.url,
    active: nextState.active,
    audible: nextState.audible,
    pinned: nextState.pinned,
  });

  return nextState;
}

async function ensureContainerNameForState(state) {
  if (state === null || typeof state === "undefined") {
    return null;
  }

  if (!rulesRequireContainerNames()) {
    return null;
  }

  const containerName = await getCachedContainerName(state.cookieStoreId);

  if (state.containerName !== containerName) {
    tabStates.set(state.id, {
      ...state,
      containerName,
    });
  }

  return containerName;
}

async function refreshTrackedTab(tabId, reason = "refresh") {
  try {
    const previousState = tabStates.get(tabId);
    const tab = await browser.tabs.get(tabId);
    const state = upsertTabState(
      tab,
      previousState
        ? {
            lastActivatedAt: previousState.lastActivatedAt,
          }
        : undefined,
    );

    if (state && state.active && (!previousState || previousState.active !== true)) {
      markTabActive(tabId, tab.windowId, Date.now());
    }
  } catch (e) {
    tabStates.delete(tabId);
    debugLog("State refresh skipped because tab is unavailable", {
      tabId,
      reason,
      error: e && e.message ? e.message : String(e),
    });
  }
}

function markTabActive(tabId, windowId, activatedAt = Date.now()) {
  for (const [trackedTabId, state] of tabStates.entries()) {
    if (state.windowId !== windowId) {
      continue;
    }

    if (trackedTabId === tabId) {
      tabStates.set(trackedTabId, {
        ...state,
        active: true,
        lastActivatedAt: activatedAt,
      });
      continue;
    }

    if (state.active) {
      tabStates.set(trackedTabId, {
        ...state,
        active: false,
      });
    }
  }
}

async function seedRuntimeState() {
  const existingTabs = await browser.tabs.query({});
  tabStates.clear();

  existingTabs.forEach((tab) => {
    upsertTabState(tab);
  });

  for (const tab of existingTabs) {
    if (tab.active === true) {
      markTabActive(tab.id, tab.windowId, Date.now());
    }
  }

  runtimeStateSeeded = true;
  debugLog("Startup seeding count", () => ({
    totalTabs: tabStates.size,
  }));
}

async function ensureRuntimeStarted() {
  if (runtimeStarted) {
    return;
  }

  try {
    await seedRuntimeState();
  } catch (e) {
    runtimeStateSeeded = false;
    console.error(e);
    throw e;
  }

  if (!tabEventListenersRegistered) {
    registerTabEventListeners();
    tabEventListenersRegistered = true;
  }

  runtimeStarted = true;
}

function matchesRuleContainer(rule, containerName) {
  if (rule.containerNameMatcher === null) {
    return containerName === null;
  }

  if (containerName === null) {
    return false;
  }

  return rule.containerNameMatcher.test(containerName);
}

async function isIgnoredTab(state) {
  for (const rule of parsedIgnoreRules) {
    const containerName = rule.requiresContainerName
      ? await ensureContainerNameForState(state)
      : null;

    if (
      matchesRuleContainer(rule, containerName) &&
      rule.urlMatcher.test(state.url)
    ) {
      debugLog("Skipping ignored tab", {
        id: state.id,
        url: state.url,
        container: containerName,
      });
      return true;
    }
  }

  return false;
}

async function handleCloseFailure(tabId, error) {
  try {
    await browser.tabs.get(tabId);
  } catch (getError) {
    tabStates.delete(tabId);
    debugLog("Removed stale tab after close failure", {
      tabId,
      error: error && error.message ? error.message : String(error),
    });
    return;
  }

  console.error(error);
}

async function tabCleanUp(rule) {
  if (!autostart || !runtimeStateSeeded) {
    return;
  }

  const epochNow = Date.now();
  const effectiveCloseActive = closeAllMatching || closeActive;
  const effectiveCloseAudible = closeAllMatching || closeAudible;
  const effectiveClosePinned = closeAllMatching || closePinned;
  const candidates = [];

  debugLog("Starting tab cleanup", () => ({
    minIdleTimeMilliSecs: rule.minIdleTimeMilliSecs,
    closeThreshold,
    effectiveCloseActive,
    effectiveCloseAudible,
    effectiveClosePinned,
    trackedTabs: tabStates.size,
  }));

  for (const state of tabStates.values()) {
    if (state.windowType !== "normal") {
      continue;
    }
    if (!effectiveCloseActive && state.active) {
      continue;
    }
    if (!effectiveCloseAudible && state.audible) {
      continue;
    }
    if (!effectiveClosePinned && state.pinned) {
      continue;
    }
    if (await isIgnoredTab(state)) {
      continue;
    }

    const containerName = rule.requiresContainerName
      ? await ensureContainerNameForState(state)
      : null;

    if (!matchesRuleContainer(rule, containerName)) {
      debugLog("Skipping tab due to container mismatch", {
        id: state.id,
        url: state.url,
        container: containerName,
      });
      continue;
    }

    if (!rule.urlMatcher.test(state.url)) {
      debugLog("Skipping tab due to URL mismatch", {
        id: state.id,
        url: state.url,
      });
      continue;
    }

    const idleMs = epochNow - state.lastActivatedAt;
    if (idleMs < rule.minIdleTimeMilliSecs) {
      debugLog("Skipping tab due to idle time", {
        id: state.id,
        url: state.url,
        idleMs,
        requiredIdleMs: rule.minIdleTimeMilliSecs,
      });
      continue;
    }

    candidates.push({
      state,
      containerName,
      idleMs,
    });
  }

  candidates.sort((a, b) => a.state.lastActivatedAt - b.state.lastActivatedAt);

  debugLog("Tabs eligible after in-memory filtering", () => ({
    count: candidates.length,
    tabs: candidates.map(({ state }) => ({
      id: state.id,
      url: state.url,
      active: state.active,
      audible: state.audible,
      pinned: state.pinned,
      lastActivatedAt: state.lastActivatedAt,
    })),
  }));

  let maxNbOfTabsToClose = candidates.length - closeThreshold;
  if (maxNbOfTabsToClose < 1) {
    debugLog("Nothing to close", () => ({
      eligibleTabs: candidates.length,
      closeThreshold,
    }));
    return;
  }

  for (const candidate of candidates) {
    if (maxNbOfTabsToClose < 1) {
      break;
    }

    const { state, idleMs } = candidate;

    try {
      if (typeof saveFolder === "string" && saveFolder !== "") {
        browser.bookmarks.create({
          title: state.title,
          url: state.url,
          parentId: saveFolder,
        });
      }

      debugLog("Closing tab", {
        id: state.id,
        url: state.url,
        idleMs,
      });
      await browser.tabs.remove(state.id);
      tabStates.delete(state.id);
      debugLog("Closed tab successfully", {
        id: state.id,
        url: state.url,
        idleMs,
      });
      maxNbOfTabsToClose--;
    } catch (e) {
      await handleCloseFailure(state.id, e);
    }
  }
}

async function validateTrackedStateAgainstLiveQuery() {
  if (!debug) {
    return;
  }

  try {
    const liveNormalTabs = await browser.tabs.query({
      windowType: "normal",
    });
    const trackedNormalTabs = Array.from(tabStates.values()).filter(
      (state) => state.windowType === "normal",
    );

    debugLog("Tracked state validation", {
      trackedNormalTabs: trackedNormalTabs.length,
      liveNormalTabs: liveNormalTabs.length,
    });
  } catch (e) {
    console.error(e);
  }
}

async function reconcileTrackedState() {
  if (!runtimeStateSeeded) {
    return;
  }

  const liveTabs = await browser.tabs.query({});
  const liveTabsById = new Map(liveTabs.map((tab) => [tab.id, tab]));
  let corrections = 0;

  for (const tab of liveTabs) {
    const trackedState = tabStates.get(tab.id);

    if (!trackedState) {
      upsertTabState(tab);
      corrections++;
      continue;
    }

    const expectedWindowType = tab.windowType || "normal";
    const expectedUrl = typeof tab.url === "string" ? tab.url : "";
    const expectedTitle = typeof tab.title === "string" ? tab.title : "";
    const expectedCookieStoreId =
      typeof tab.cookieStoreId === "string" ? tab.cookieStoreId : "";

    if (
      trackedState.windowId !== tab.windowId ||
      trackedState.windowType !== expectedWindowType ||
      trackedState.url !== expectedUrl ||
      trackedState.title !== expectedTitle ||
      trackedState.active !== (tab.active === true) ||
      trackedState.audible !== (tab.audible === true) ||
      trackedState.pinned !== (tab.pinned === true) ||
      trackedState.cookieStoreId !== expectedCookieStoreId
    ) {
      upsertTabState(tab, {
        lastActivatedAt: trackedState.lastActivatedAt,
      });
      corrections++;
    }

    if (tab.active === true && trackedState.active !== true) {
      markTabActive(tab.id, tab.windowId, Date.now());
      corrections++;
    }
  }

  for (const tabId of Array.from(tabStates.keys())) {
    if (!liveTabsById.has(tabId)) {
      tabStates.delete(tabId);
      corrections++;
    }
  }

  const activeTabIdsByWindow = new Map();
  for (const state of tabStates.values()) {
    if (state.active !== true) {
      continue;
    }

    if (!activeTabIdsByWindow.has(state.windowId)) {
      activeTabIdsByWindow.set(state.windowId, []);
    }

    activeTabIdsByWindow.get(state.windowId).push(state.id);
  }

  for (const [windowId, activeTabIds] of activeTabIdsByWindow.entries()) {
    if (activeTabIds.length > 1) {
      console.warn("[TabAutoClose] Multiple tracked active tabs", {
        windowId,
        activeTabIds,
      });
    }
  }

  debugLog("Reconciliation corrections", {
    corrections,
    trackedTabs: tabStates.size,
    liveTabs: liveTabs.length,
  });

  await validateTrackedStateAgainstLiveQuery();
}

function startCleanupIntervals() {
  parsedIntervalRules.forEach((rule) => {
    cleanupIntervalIds.push(
      setInterval(() => {
        tabCleanUp(rule);
      }, rule.minIdleTimeMilliSecs),
    );
  });
}

function startReconciliationInterval() {
  clearReconciliationInterval();
  reconciliationIntervalId = setInterval(() => {
    if (!autostart) {
      return;
    }

    reconcileTrackedState().catch((e) => {
      console.error(e);
    });
  }, RECONCILIATION_INTERVAL_MS);
}

async function reloadParsedRulesFromStorage() {
  parsedIgnoreRules = parseIgnoreRules(
    await getFromStorage("string", "ignorerules_container_regex", ""),
    await getFromStorage("string", "ignorerules_url_regex", ""),
  );
  parsedIntervalRules = parseIntervalRules(
    await getFromStorage("string", "intervalrules_seconds_and_container_regex", ""),
    await getFromStorage("string", "intervalrules_url_regex", ""),
  );
  containerNameCache.clear();
}

async function onBAClicked() {
  await setToStorage("autostart", !autostart);
  await onStorageChanged();
}

async function onStorageChanged() {
  const settingsInitialized = await getSettingsInitializedFromStorage();

  if (!settingsInitialized) {
    runtimeStarted = false;
    runtimeStateSeeded = false;
    stopAllScheduledWork();
    updateBadge("cfg", "gray");
    return;
  }

  if (!runtimeStarted) {
    await ensureRuntimeStarted();
  }

  autostart = await getFromStorage("boolean", "autostart", false);
  saveFolder = await getFromStorage("string", "saveFolder", "unfiled_____");
  closeThreshold = await getFromStorage(
    "number",
    "closeThreshold",
    closeThreshold,
  );
  closeAllMatching = await getFromStorage("boolean", "closeAllMatching", false);
  closeActive = await getFromStorage("boolean", "closeActive", false);
  closeAudible = await getFromStorage("boolean", "closeAudible", false);
  closePinned = await getFromStorage("boolean", "closePinned", false);
  debug = await getDebugFromStorage();

  await reloadParsedRulesFromStorage();

  debugLog("Storage changed", () => ({
    autostart,
    closeThreshold,
    closeAllMatching,
    closeActive,
    closeAudible,
    closePinned,
    debug,
    saveFolder,
    parsedIgnoreRules: parsedIgnoreRules.length,
    parsedIntervalRules: parsedIntervalRules.length,
  }));

  stopAllScheduledWork();

  if (!autostart) {
    updateBadge("off", "red");
    return;
  }

  updateBadge("on", "green");

  if (!runtimeStateSeeded) {
    console.warn("[TabAutoClose] Cleanup not started because runtime state is not seeded.");
    return;
  }

  startCleanupIntervals();
  startReconciliationInterval();
  await reconcileTrackedState();
}

function registerTabEventListeners() {
  browser.tabs.onCreated.addListener((tab) => {
    const createdAt = Date.now();
    upsertTabState(tab, {
      lastActivatedAt:
        typeof tab.lastAccessed === "number" ? tab.lastAccessed : createdAt,
    });

    if (tab.active === true) {
      markTabActive(tab.id, tab.windowId, createdAt);
    }
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const existingState = tabStates.get(tabId);

    if (!existingState) {
      refreshTrackedTab(tabId, "onUpdated");
      return;
    }

    const nextPatch = {
      windowId: tab && typeof tab.windowId === "number" ? tab.windowId : undefined,
      windowType:
        tab && typeof tab.windowType === "string" ? tab.windowType : undefined,
      url:
        typeof changeInfo.url === "string"
          ? changeInfo.url
          : tab && typeof tab.url === "string"
            ? tab.url
            : undefined,
      title:
        typeof changeInfo.title === "string"
          ? changeInfo.title
          : tab && typeof tab.title === "string"
            ? tab.title
            : undefined,
      active:
        typeof changeInfo.active === "boolean"
          ? changeInfo.active
          : tab && typeof tab.active === "boolean"
            ? tab.active
            : undefined,
      audible:
        typeof changeInfo.audible === "boolean"
          ? changeInfo.audible
          : tab && typeof tab.audible === "boolean"
            ? tab.audible
            : undefined,
      pinned:
        typeof changeInfo.pinned === "boolean"
          ? changeInfo.pinned
          : tab && typeof tab.pinned === "boolean"
            ? tab.pinned
            : undefined,
      cookieStoreId:
        tab && typeof tab.cookieStoreId === "string"
          ? tab.cookieStoreId
          : undefined,
    };

    const mergedState = mergeTabState(existingState, nextPatch);

    if (
      typeof nextPatch.cookieStoreId === "string" &&
      nextPatch.cookieStoreId !== existingState.cookieStoreId
    ) {
      mergedState.containerName = null;
    }

    tabStates.set(tabId, mergedState);
    debugLog("State entry updated", {
      id: tabId,
      changedKeys: Object.keys(changeInfo),
    });

    if (
      mergedState.active === true &&
      (changeInfo.active === true || existingState.active !== true)
    ) {
      markTabActive(tabId, mergedState.windowId, Date.now());
    }
  });

  browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
    if (!tabStates.has(tabId)) {
      refreshTrackedTab(tabId, "onActivated");
      return;
    }

    markTabActive(tabId, windowId, Date.now());
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    if (tabStates.delete(tabId)) {
      debugLog("State entry removed", {
        tabId,
      });
    }
  });

  browser.tabs.onAttached.addListener((tabId, attachInfo) => {
    const existingState = tabStates.get(tabId);

    if (!existingState) {
      refreshTrackedTab(tabId, "onAttached");
      return;
    }

    tabStates.set(tabId, {
      ...existingState,
      windowId: attachInfo.newWindowId,
    });
    refreshTrackedTab(tabId, "onAttached");
  });

  browser.tabs.onDetached.addListener((tabId, detachInfo) => {
    const existingState = tabStates.get(tabId);

    if (!existingState) {
      refreshTrackedTab(tabId, "onDetached");
      return;
    }

    tabStates.set(tabId, {
      ...existingState,
      windowId: detachInfo.oldWindowId,
    });
  });
}

(async () => {
  await onStorageChanged();
  browser.browserAction.onClicked.addListener(onBAClicked);
  browser.storage.onChanged.addListener(() => {
    onStorageChanged();
  });
  browser.runtime.onMessage.addListener((data) => {
    if (data.cmd === "storageChanged") {
      onStorageChanged();
    }
  });
})();
