const test = require("node:test");
const assert = require("node:assert/strict");

const background = require("../background.js");

test.beforeEach(() => {
  background.resetRuntimeStateForTests();
});

test("coerceStoredValue normalizes booleans and numbers from storage", () => {
  assert.equal(background.coerceStoredValue("boolean", true), true);
  assert.equal(background.coerceStoredValue("boolean", " true "), true);
  assert.equal(background.coerceStoredValue("boolean", "FALSE"), false);
  assert.equal(background.coerceStoredValue("boolean", "maybe"), undefined);

  assert.equal(background.coerceStoredValue("number", 42), 42);
  assert.equal(background.coerceStoredValue("number", "17"), 17);
  assert.equal(background.coerceStoredValue("number", " 08 "), 8);
  assert.equal(background.coerceStoredValue("number", ""), undefined);
  assert.equal(background.coerceStoredValue("number", "abc"), undefined);
});

test("parseIgnoreRules keeps valid rules and skips comments and empty pairs", () => {
  const rules = background.parseIgnoreRules(
    [
      "Personal",
      "",
      "# comment",
      "Work",
      "",
      "",
    ].join("\n"),
    [
      "example\\.com",
      "mozilla\\.org",
      "# comment",
      "",
      "",
      "^https://docs\\.",
    ].join("\n"),
  );

  assert.equal(rules.length, 4);
  assert.equal(rules[0].requiresContainerName, true);
  assert.equal(rules[0].containerNameMatcher.test("Personal"), true);
  assert.equal(rules[0].urlMatcher.test("https://example.com"), true);

  assert.equal(rules[1].requiresContainerName, false);
  assert.equal(rules[1].containerNameMatcher, null);
  assert.equal(rules[1].urlMatcher.test("https://mozilla.org"), true);

  assert.equal(rules[2].requiresContainerName, true);
  assert.equal(rules[2].containerNameMatcher.test("Work"), true);
  assert.equal(rules[2].urlMatcher, null);

  assert.equal(rules[3].requiresContainerName, false);
  assert.equal(rules[3].containerNameMatcher, null);
  assert.equal(rules[3].urlMatcher.test("https://docs.example"), true);
});

test("parseIntervalRules parses valid rows and ignores malformed input", () => {
  const rules = background.parseIntervalRules(
    [
      "30,Personal",
      "bad,Work",
      "15",
      "# comment",
      "45,",
      "90,Shopping,Archive",
    ].join("\n"),
    [
      "example\\.com",
      "ignored\\.com",
      "missing-container\\.com",
      "# comment",
      "docs\\.",
      "shop\\.",
    ].join("\n"),
  );

  assert.equal(rules.length, 3);

  assert.deepEqual(
    rules.map((rule) => rule.minIdleTimeMilliSecs),
    [30000, 45000, 90000],
  );
  assert.equal(rules[0].containerNameMatcher.test("Personal"), true);
  assert.equal(rules[1].containerNameMatcher, null);
  assert.equal(rules[1].urlMatcher.test("https://docs.example"), true);
  assert.equal(rules[2].containerNameMatcher.test("Shopping,Archive"), true);
});

test("buildTabState applies defaults and tracks active timestamps", () => {
  const originalNow = Date.now;
  Date.now = () => 123456;

  try {
    const activeState = background.buildTabState({
      id: 1,
      windowId: 10,
      active: true,
      url: "https://example.com",
      title: "Example",
      cookieStoreId: "firefox-container-1",
    });
    assert.equal(activeState.lastActivatedAt, 123456);
    assert.equal(activeState.windowType, "normal");
    assert.equal(activeState.audible, false);
    assert.equal(activeState.pinned, false);

    const inactiveState = background.buildTabState({
      id: 2,
      windowId: 10,
      active: false,
      lastAccessed: 9000,
    });
    assert.equal(inactiveState.lastActivatedAt, 9000);
    assert.equal(inactiveState.url, "");
    assert.equal(inactiveState.title, "");
    assert.equal(inactiveState.cookieStoreId, "");
  } finally {
    Date.now = originalNow;
  }
});

test("markTabActive keeps one active tab per window", () => {
  background.upsertTabState({
    id: 1,
    windowId: 10,
    active: true,
    url: "https://one.example",
  });
  background.upsertTabState({
    id: 2,
    windowId: 10,
    active: false,
    url: "https://two.example",
  });
  background.upsertTabState({
    id: 3,
    windowId: 20,
    active: true,
    url: "https://three.example",
  });

  background.markTabActive(2, 10, 777);

  const tracked = background.getTrackedTabStatesForTests();
  assert.equal(tracked.get(1).active, false);
  assert.equal(tracked.get(2).active, true);
  assert.equal(tracked.get(2).lastActivatedAt, 777);
  assert.equal(tracked.get(3).active, true);
});

test("matchesRuleContainer handles null and regex-backed container rules", () => {
  assert.equal(
    background.matchesRuleContainer(
      { containerNameMatcher: null },
      null,
    ),
    true,
  );
  assert.equal(
    background.matchesRuleContainer(
      { containerNameMatcher: null },
      "Personal",
    ),
    false,
  );
  assert.equal(
    background.matchesRuleContainer(
      { containerNameMatcher: /Work/ },
      "Work",
    ),
    true,
  );
  assert.equal(
    background.matchesRuleContainer(
      { containerNameMatcher: /Work/ },
      null,
    ),
    false,
  );
});

test("tabCleanUp closes the oldest eligible tabs beyond the threshold and bookmarks them", async () => {
  const removedTabIds = [];
  const bookmarkPayloads = [];

  global.browser = {
    bookmarks: {
      create(payload) {
        bookmarkPayloads.push(payload);
        return Promise.resolve(payload);
      },
    },
    tabs: {
      remove(tabId) {
        removedTabIds.push(tabId);
        return Promise.resolve();
      },
      get() {
        return Promise.reject(new Error("unexpected tabs.get"));
      },
    },
  };

  background.configureRuntimeForTests({
    autostart: true,
    runtimeStateSeeded: true,
    closeThreshold: 1,
    saveFolder: "bookmark-folder",
  });

  background.upsertTabState({
    id: 11,
    windowId: 1,
    windowType: "normal",
    url: "https://oldest.example",
    title: "Oldest",
    active: false,
  }, { lastActivatedAt: 1000 });
  background.upsertTabState({
    id: 12,
    windowId: 1,
    windowType: "normal",
    url: "https://middle.example",
    title: "Middle",
    active: false,
  }, { lastActivatedAt: 2000 });
  background.upsertTabState({
    id: 13,
    windowId: 1,
    windowType: "normal",
    url: "https://newest.example",
    title: "Newest",
    active: false,
  }, { lastActivatedAt: 3000 });

  const originalNow = Date.now;
  Date.now = () => 100000;

  try {
    await background.tabCleanUp({
      minIdleTimeMilliSecs: 1000,
      containerNameMatcher: null,
      urlMatcher: /example/,
      requiresContainerName: false,
    });
  } finally {
    Date.now = originalNow;
    delete global.browser;
  }

  assert.deepEqual(removedTabIds, [11, 12]);
  assert.deepEqual(
    bookmarkPayloads.map((payload) => payload.url),
    ["https://oldest.example", "https://middle.example"],
  );
  assert.equal(background.getTrackedTabStatesForTests().has(13), true);
  assert.equal(background.getTrackedTabStatesForTests().has(11), false);
});

test("tabCleanUp respects active, audible, pinned, and ignored exclusions", async () => {
  const removedTabIds = [];

  global.browser = {
    bookmarks: {
      create() {
        return Promise.resolve();
      },
    },
    tabs: {
      remove(tabId) {
        removedTabIds.push(tabId);
        return Promise.resolve();
      },
      get() {
        return Promise.reject(new Error("unexpected tabs.get"));
      },
    },
  };

  background.configureRuntimeForTests({
    autostart: true,
    runtimeStateSeeded: true,
    closeThreshold: 0,
    parsedIgnoreRules: background.parseIgnoreRules("", "ignored\\.example"),
  });

  background.upsertTabState({
    id: 21,
    windowId: 1,
    url: "https://active.example",
    active: true,
  }, { lastActivatedAt: 1000 });
  background.upsertTabState({
    id: 22,
    windowId: 1,
    url: "https://audible.example",
    active: false,
    audible: true,
  }, { lastActivatedAt: 1000 });
  background.upsertTabState({
    id: 23,
    windowId: 1,
    url: "https://pinned.example",
    active: false,
    pinned: true,
  }, { lastActivatedAt: 1000 });
  background.upsertTabState({
    id: 24,
    windowId: 1,
    url: "https://ignored.example",
    active: false,
  }, { lastActivatedAt: 1000 });
  background.upsertTabState({
    id: 25,
    windowId: 1,
    url: "https://eligible.example",
    title: "Eligible",
    active: false,
  }, { lastActivatedAt: 1000 });

  const originalNow = Date.now;
  Date.now = () => 100000;

  try {
    await background.tabCleanUp({
      minIdleTimeMilliSecs: 1000,
      containerNameMatcher: null,
      urlMatcher: /example/,
      requiresContainerName: false,
    });
  } finally {
    Date.now = originalNow;
    delete global.browser;
  }

  assert.deepEqual(removedTabIds, [25]);
});

test("tabCleanUp can include active, audible, and pinned tabs when closeAllMatching is enabled", async () => {
  const removedTabIds = [];

  global.browser = {
    bookmarks: {
      create() {
        return Promise.resolve();
      },
    },
    tabs: {
      remove(tabId) {
        removedTabIds.push(tabId);
        return Promise.resolve();
      },
      get() {
        return Promise.reject(new Error("unexpected tabs.get"));
      },
    },
  };

  background.configureRuntimeForTests({
    autostart: true,
    runtimeStateSeeded: true,
    closeThreshold: 0,
    closeAllMatching: true,
  });

  background.upsertTabState({
    id: 31,
    windowId: 1,
    url: "https://active.example",
    active: true,
  }, { lastActivatedAt: 1000 });
  background.upsertTabState({
    id: 32,
    windowId: 1,
    url: "https://audible.example",
    active: false,
    audible: true,
  }, { lastActivatedAt: 1100 });
  background.upsertTabState({
    id: 33,
    windowId: 1,
    url: "https://pinned.example",
    active: false,
    pinned: true,
  }, { lastActivatedAt: 1200 });

  const originalNow = Date.now;
  Date.now = () => 100000;

  try {
    await background.tabCleanUp({
      minIdleTimeMilliSecs: 1000,
      containerNameMatcher: null,
      urlMatcher: /example/,
      requiresContainerName: false,
    });
  } finally {
    Date.now = originalNow;
    delete global.browser;
  }

  assert.deepEqual(removedTabIds, [31, 32, 33]);
});

test("tabCleanUp removes stale tracked tabs when close fails because the tab is gone", async () => {
  const removedTabIds = [];

  global.browser = {
    bookmarks: {
      create() {
        return Promise.resolve();
      },
    },
    tabs: {
      remove(tabId) {
        removedTabIds.push(tabId);
        return Promise.reject(new Error("close failed"));
      },
      get() {
        return Promise.reject(new Error("tab missing"));
      },
    },
  };

  background.configureRuntimeForTests({
    autostart: true,
    runtimeStateSeeded: true,
    closeThreshold: 0,
  });

  background.upsertTabState({
    id: 41,
    windowId: 1,
    url: "https://gone.example",
    active: false,
  }, { lastActivatedAt: 1000 });

  const originalNow = Date.now;
  Date.now = () => 100000;

  try {
    await background.tabCleanUp({
      minIdleTimeMilliSecs: 1000,
      containerNameMatcher: null,
      urlMatcher: /gone/,
      requiresContainerName: false,
    });
  } finally {
    Date.now = originalNow;
    delete global.browser;
  }

  assert.deepEqual(removedTabIds, [41]);
  assert.equal(background.getTrackedTabStatesForTests().has(41), false);
});
