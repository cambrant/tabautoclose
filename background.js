/* global browser */

let closeThreshold = 7;
let saveFolder = "unfiled_____";
let setIntervalIds = [];
let autostart = false;
let ignoreRules = [];
let closeAllMatching = false;
let closeActive = false;
let closeAudible = false;
let closePinned = false;
let debug = false;

// Track when each tab was last activated (switched to) ourselves.
// This is the primary idle-time source because:
// - Firefox's tab.lastAccessed updates on in-tab interactions (mouse, keyboard),
//   which would prevent tabs from ever appearing idle.
// - Chrome/Edge don't have tab.lastAccessed at all.
const tabActivatedAt = new Map();

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

async function getFromStorage(type, id, fallback) {
  let tmp = await browser.storage.local.get(id);
  if (typeof tmp[id] === type) {
    return tmp[id];
  } else {
    setToStorage(id, fallback);
    return fallback;
  }
}

async function rebuildIgnoreRules(
  ignorerulesStr_container_regexs,
  ignorerulesStr_url_regexs,
) {
  ignoreRules = [];

  const container_regexs = ignorerulesStr_container_regexs.split("\n");
  const url_regexs = ignorerulesStr_url_regexs.split("\n");

  for (let i = 0; i < container_regexs.length && i < url_regexs.length; i++) {
    try {
      const left = container_regexs[i].trim();
      const right = url_regexs[i].trim();

      if (!left.startsWith("#") && !right.startsWith("#")) {
        const containerNameMatcher = left === "" ? null : new RegExp(left);
        const urlMatcher = right === "" ? null : new RegExp(right);
        if (urlMatcher !== null) {
          ignoreRules.push({ containerNameMatcher, urlMatcher });
        }
      }
    } catch (e) {
      console.error(e);
    }
  }
}

async function rebuildIntervalHandlers(
  intervalrulesStr_time_ms_and_container_regexs,
  intervalrulesStr_url_regexs,
) {
  // now lets rebuild and start the new interval handlers

  const time_ms_and_container_regexs =
    intervalrulesStr_time_ms_and_container_regexs.split("\n");
  const url_regexs = intervalrulesStr_url_regexs.split("\n");

  for (
    let i = 0;
    i < time_ms_and_container_regexs.length && i < url_regexs.length;
    i++
  ) {
    try {
      let left = time_ms_and_container_regexs[i].trim();
      let right = url_regexs[i].trim();

      if (
        !left.startsWith("#") &&
        !right.startsWith("#") &&
        right !== "" &&
        left !== ""
      ) {
        const left_parts = left.split(",");
        if (left_parts.length < 2) {
          continue;
        }

        const minIdleTimeMilliSecs = parseInt(left_parts[0].trim());

        left = left_parts.slice(1).join(",");

        const containerNameMatcher = left === "" ? null : new RegExp(left);
        const urlMatcher = right === "" ? null : new RegExp(right);

        setIntervalIds.push(
          setInterval(() => {
            tabCleanUp({
              minIdleTimeMilliSecs,
              containerNameMatcher,
              urlMatcher,
              //consider_hasText,
            });
          }, minIdleTimeMilliSecs),
        );
      }
    } catch (e) {
      console.error(e);
    }
  }
}

async function getContainerNameFromCookieStoreId(csid) {
  // contextualIdentities is Firefox-only; skip on other browsers
  if (!browser.contextualIdentities) {
    return null;
  }
  try {
    const contextualIdentity = await browser.contextualIdentities.get(csid);
    return contextualIdentity.name;
  } catch (e) {
    // not inside a container
  }
  return null;
}

async function getCachedContainerName(containerNameCache, cookieStoreId) {
  if (!containerNameCache.has(cookieStoreId)) {
    containerNameCache.set(
      cookieStoreId,
      await getContainerNameFromCookieStoreId(cookieStoreId),
    );
  }
  return containerNameCache.get(cookieStoreId);
}

async function tabCleanUp(input) {
  if (!autostart) {
    return;
  }

  // to check idle time
  const epoch_now = Date.now();

  const query = {
    // care only about normal windows
    windowType: "normal",
  };

  const effectiveCloseActive = closeAllMatching || closeActive;
  const effectiveCloseAudible = closeAllMatching || closeAudible;
  const effectiveClosePinned = closeAllMatching || closePinned;

  if (!effectiveCloseActive) {
    query.active = false;
  }
  if (!effectiveCloseAudible) {
    query.audible = false;
  }
  if (!effectiveClosePinned) {
    query.pinned = false;
  }

  debugLog("Starting tab cleanup", () => ({
    minIdleTimeMilliSecs: input.minIdleTimeMilliSecs,
    closeThreshold,
    effectiveCloseActive,
    effectiveCloseAudible,
    effectiveClosePinned,
    query,
  }));

  const containerNameCache = new Map();
  const tabCandidates = await Promise.all(
    (await browser.tabs.query(query)).map(async (tab) => {
      const containerName = await getCachedContainerName(
        containerNameCache,
        tab.cookieStoreId,
      );

      for (const el of ignoreRules) {
        if (el.containerNameMatcher === null) {
          if (containerName === null && el.urlMatcher.test(tab.url)) {
            debugLog("Skipping ignored tab", {
              id: tab.id,
              url: tab.url,
              container: containerName,
            });
            return null;
          }
          continue;
        }
        if (containerName === null) {
          continue;
        }
        if (el.containerNameMatcher.test(containerName) &&
            el.urlMatcher.test(tab.url)) {
          debugLog("Skipping ignored tab", {
            id: tab.id,
            url: tab.url,
            container: containerName,
          });
          return null;
        }
      }

      return {
        tab,
        containerName,
        lastActive: tabActivatedAt.get(tab.id) || tab.lastAccessed || 0,
      };
    }),
  );

  let all_tabs = tabCandidates.filter((candidate) => candidate !== null).sort((a, b) => {
    return a.lastActive - b.lastActive;
  });

  debugLog("Tabs eligible after initial filtering", () => ({
    count: all_tabs.length,
    tabs: all_tabs.map(({ tab }) => ({
      id: tab.id,
      url: tab.url,
      active: tab.active,
      audible: tab.audible,
      pinned: tab.pinned,
    })),
  }));

  let max_nb_of_tabs_to_close = all_tabs.length - closeThreshold;

  if (max_nb_of_tabs_to_close < 1) {
    debugLog("Nothing to close", () => ({
      eligibleTabs: all_tabs.length,
      closeThreshold,
    }));
    return;
  }

  for (const candidate of all_tabs) {
    // stop when we reach the closeThreshold
    if (max_nb_of_tabs_to_close < 1) {
      continue;
    }

    const { tab, containerName, lastActive } = candidate;
    // check the container
    if (input.containerNameMatcher !== null) {
      if (containerName !== null) {
        if (!input.containerNameMatcher.test(containerName)) {
          debugLog("Skipping tab due to container mismatch", {
            id: tab.id,
            url: tab.url,
            container: containerName,
          });
          continue;
        }
      } else {
        // cn := null
        debugLog("Skipping tab without container for container rule", {
          id: tab.id,
          url: tab.url,
        });
        continue;
      }
    } else {
      // containerNameMatcher === null
      if (containerName !== null) {
        debugLog("Skipping container tab for non-container rule", {
          id: tab.id,
          url: tab.url,
          container: containerName,
        });
        continue;
      }
      // cn === containerNameMatcher
    }

    // check the URL
    if (input.urlMatcher !== null) {
      if (!input.urlMatcher.test(tab.url)) {
        debugLog("Skipping tab due to URL mismatch", { id: tab.id, url: tab.url });
        continue;
      }
    }

    // check the idle aka. last accessed time of the tab
    // Use our own tracked activation time as primary source (cross-browser).
    // Fall back to tab.lastAccessed (Firefox-only) if we don't have data yet.
    const delta = epoch_now - lastActive;
    if (delta < input.minIdleTimeMilliSecs) {
      debugLog("Skipping tab due to idle time", {
        id: tab.id,
        url: tab.url,
        idleMs: delta,
        requiredIdleMs: input.minIdleTimeMilliSecs,
      });
      continue;
    }

    try {
      if (typeof saveFolder === "string" && saveFolder !== "") {
        let createdetails = {
          title: tab.title,
          url: tab.url,
          parentId: saveFolder,
        };
        browser.bookmarks.create(createdetails);
      }
    } catch (e) {
      console.error(e);
    }
    debugLog("Closing tab", {
      id: tab.id,
      url: tab.url,
      idleMs: delta,
    });
    await browser.tabs.remove(tab.id);
    debugLog("Closed tab successfully", {
      id: tab.id,
      url: tab.url,
      idleMs: delta,
    });
    max_nb_of_tabs_to_close--;
  }
}

async function onBAClicked(tab) {
  setToStorage("autostart", !autostart);
  onStorageChanged();
}

async function onStorageChanged() {
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
  debug = await getFromStorage("boolean", "debug", false);

  debugLog("Storage changed", () => ({
    autostart,
    closeThreshold,
    closeAllMatching,
    closeActive,
    closeAudible,
    closePinned,
    debug,
    saveFolder,
  }));

  if (autostart) {
    updateBadge("on", "green");

    // stop all running intervals
    setIntervalIds.forEach((id) => {
      clearInterval(id);
    });
    setIntervalIds = [];

    rebuildIgnoreRules(
      await getFromStorage("string", "ignorerules_container_regex", ""),
      await getFromStorage("string", "ignorerules_url_regex", ""),
    );
    rebuildIntervalHandlers(
      await getFromStorage(
        "string",
        "intervalrules_time_ms_and_container_regex",
        "",
      ),
      await getFromStorage("string", "intervalrules_url_regex", ""),
    );
  } else {
    updateBadge("off", "red");
  }
}

(async () => {
  // Seed activation times for all existing tabs.
  // Use tab.lastAccessed (Firefox) if available, otherwise treat as just-accessed.
  const now = Date.now();
  const existingTabs = await browser.tabs.query({});
  for (const t of existingTabs) {
    tabActivatedAt.set(t.id, t.lastAccessed || now);
  }

  // Track tab activations ourselves
  browser.tabs.onActivated.addListener(({ tabId }) => {
    tabActivatedAt.set(tabId, Date.now());
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    tabActivatedAt.delete(tabId);
  });
  browser.tabs.onCreated.addListener((tab) => {
    tabActivatedAt.set(tab.id, Date.now());
  });

  await onStorageChanged();
  browser.browserAction.onClicked.addListener(onBAClicked);
  browser.runtime.onMessage.addListener((data, sender) => {
    if (data.cmd === "storageChanged") {
      onStorageChanged();
    }
  });
})();

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    browser.runtime.openOptionsPage();
  }
});
