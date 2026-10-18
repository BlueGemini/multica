import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  columnWidthKey,
  readColumnWidths,
  readTableModel,
  tableMarkdownFromSource,
  tableToCsv,
  writeColumnWidths,
} from "./rich-table-model";

const h = createElement;

describe("readTableModel", () => {
  it("reads header and body cells from react-markdown's table children", () => {
    const children = [
      h("thead", { key: "h" }, "\n", h("tr", null, h("th", null, "Name"), h("th", null, "Note"))),
      "\n",
      h(
        "tbody",
        { key: "b" },
        h("tr", null, h("td", null, "a"), h("td", null, "see ", h("code", null, "cursor-agent"))),
        h("tr", null, h("td", null, "b"), h("td", null)),
      ),
    ];
    const model = readTableModel(children);
    expect(model.headerText).toEqual(["Name", "Note"]);
    expect(model.rowText).toEqual([
      ["a", "see cursor-agent"],
      ["b", ""],
    ]);
    expect(model.rows).toHaveLength(2);
  });
});

describe("tableMarkdownFromSource", () => {
  it("undoes the readonly preprocessing a table can contain", () => {
    const processed = [
      "intro",
      "| Issue | Link | Note |",
      "| --- | --- | --- |",
      "| [MUL-12](mention://issue/MUL-12) | [https://example.com](https://example.com) | <mark>hot</mark> |",
      "| [Docs](https://example.com/docs) | [example.com](http://example.com) | [MUL-9](mention://issue/9b1c0d3e) |",
    ].join("\n");
    const start = processed.indexOf("| Issue");
    expect(tableMarkdownFromSource(processed, start, processed.length)).toBe(
      [
        "| Issue | Link | Note |",
        "| --- | --- | --- |",
        "| MUL-12 | https://example.com | ==hot== |",
        "| [Docs](https://example.com/docs) | example.com | [MUL-9](mention://issue/9b1c0d3e) |",
      ].join("\n"),
    );
  });

  it("returns nothing without a source position", () => {
    expect(tableMarkdownFromSource("| a |", undefined, 5)).toBe("");
  });
});

describe("tableToCsv", () => {
  it("quotes fields that contain a separator, quote or newline", () => {
    expect(tableToCsv(["a", "b"], [["1,2", 'say "hi"'], ["x\ny", "plain"]])).toBe(
      'a,b\n"1,2","say ""hi"""\n"x\ny",plain',
    );
  });
});

describe("column width storage", () => {
  afterEach(() => window.localStorage.clear());

  const model = { headerText: ["a", "b"], rowText: [["1", "2"]] };

  it("round-trips widths and forgets them on reset", () => {
    const key = columnWidthKey(model);
    writeColumnWidths(key, [120, 240]);
    expect(readColumnWidths(key, 2)).toEqual([120, 240]);
    writeColumnWidths(key, null);
    expect(readColumnWidths(key, 2)).toBeNull();
  });

  it("ignores widths stored for a different column count", () => {
    const key = columnWidthKey(model);
    writeColumnWidths(key, [120, 240]);
    expect(readColumnWidths(key, 3)).toBeNull();
  });

  it("keys a table by its content", () => {
    expect(columnWidthKey(model)).toBe(columnWidthKey({ ...model }));
    expect(columnWidthKey(model)).not.toBe(
      columnWidthKey({ headerText: ["a", "b"], rowText: [["1", "3"]] }),
    );
  });

  it("keeps only the most recently used tables", () => {
    for (let i = 0; i < 205; i++) writeColumnWidths(`k${i}`, [100]);
    const stored = JSON.parse(window.localStorage.getItem("multica:rich-table-widths") ?? "{}");
    expect(Object.keys(stored)).toHaveLength(200);
  });

  it("survives a corrupt entry", () => {
    window.localStorage.setItem("multica:rich-table-widths", "{not json");
    expect(readColumnWidths("k", 1)).toBeNull();
    writeColumnWidths("k", [90]);
    expect(readColumnWidths("k", 1)).toEqual([90]);
  });
});
