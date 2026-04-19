const test = require("node:test");
const assert = require("node:assert/strict");

const options = require("../options.js");

test("parsePairedRuleLines groups paired comments with the next rule row", () => {
  const rows = options.parsePairedRuleLines(
    [
      "# first",
      "# second",
      "10,Personal",
      "",
      "# url only",
      "",
    ].join("\n"),
    [
      "# first",
      "# second",
      "example\\.com",
      "",
      "# url only",
      "docs\\.",
    ].join("\n"),
  );

  assert.deepEqual(rows, [
    {
      left: "10,Personal",
      right: "example\\.com",
      comment: "first second",
    },
    {
      left: "",
      right: "docs\\.",
      comment: "url only",
    },
  ]);
});

test("close rule rows round-trip through serialization", () => {
  const originalRows = [
    {
      seconds: "30",
      container: "Personal",
      url: "example\\.com",
      comment: "news sites",
    },
    {
      seconds: "90",
      container: "Shopping,Archive",
      url: "shop\\.",
      comment: "",
    },
  ];

  const serialized = options.serializeCloseRuleRows(originalRows);
  const reparsed = options.parseCloseRuleRows(
    serialized.intervalrules_seconds_and_container_regex,
    serialized.intervalrules_url_regex,
  );

  assert.deepEqual(reparsed, originalRows);
});

test("ignore rule rows serialize split sections and preserve legacy pairs", () => {
  const containerRows = [
    { container: "Personal", comment: "keep this container" },
  ];
  const urlRows = [
    { url: "docs\\.", comment: "docs pages" },
  ];
  const legacyRows = [
    { left: "Work", right: "portal\\.", comment: "legacy pair" },
  ];

  const serialized = options.serializeIgnoreRuleRows(
    containerRows,
    urlRows,
    legacyRows,
  );
  const reparsed = options.parseIgnoreRuleRows(
    serialized.ignorerules_container_regex,
    serialized.ignorerules_url_regex,
  );

  assert.deepEqual(reparsed, {
    ignoreContainer: containerRows,
    ignoreUrl: urlRows,
    legacyIgnore: legacyRows,
  });
});

test("getElementValue coerces numeric fields and clamps to min", () => {
  assert.equal(
    options.getElementValue({ type: "number", value: "17", min: 5 }),
    17,
  );
  assert.equal(
    options.getElementValue({ type: "number", value: "2", min: 5 }),
    5,
  );
  assert.equal(
    options.getElementValue({ type: "number", value: "abc", min: 5 }),
    5,
  );
});

test("getElementValue returns checkbox state and plain values unchanged", () => {
  assert.equal(
    options.getElementValue({ type: "checkbox", checked: true, value: "ignored" }),
    true,
  );
  assert.equal(
    options.getElementValue({ type: "text", value: "folder-id" }),
    "folder-id",
  );
});
