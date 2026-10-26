const { tools, executeTool } = require("../lib/tools");

describe("MCP bounded text tools", () => {
  let editor;
  beforeEach(async () => {
    editor = await lumine.workspace.open();
  });
  afterEach(() => editor?.destroy());

  function hugeSource() {
    const buffer = editor.getBuffer();
    buffer.setText("word".repeat(8192));
    let source = buffer.getTextSnapshot();
    while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
    buffer.setTextInRange(buffer.getRange(), source);
    buffer.clearUndoStack();
    return source;
  }

  it("pages a line above the native string limit without a whole-line read", () => {
    const source = hugeSource();
    const text = spyOn(editor, "getText").and.throwError("Whole-buffer read");
    const line = spyOn(editor, "lineTextForBufferRow").and.throwError("Whole-line read");
    try {
      const first = tools.ReadText.execute({ maxUnits: 12 });
      expect(first.content).toBe("wordwordword");
      expect(first.hasMore).toBe(true);
      expect(first.nextPosition).toEqual({ row: 0, column: 12 });
      const next = tools.ReadText.execute({
        start: first.nextPosition,
        revision: first.revision,
        maxUnits: 8,
      });
      expect(next.content).toBe("wordword");
      const last = tools.ReadText.execute({ start: { row: 0, column: source.length - 4 } });
      expect(last.content).toBe("word");
      expect(last.hasMore).toBe(false);
      expect(last.nextPosition).toBeNull();
    } finally {
      text.and.callThrough();
      line.and.callThrough();
    }
  });

  it("preserves CRLF and surrogate boundaries and rejects changed pagination revisions", () => {
    editor.setText("ab\r\n😀cd");
    let result = tools.ReadText.execute({ maxUnits: 3 });
    const revision = result.revision;
    expect(result.content).toBe("ab");
    let all = result.content;
    while (result.hasMore) {
      result = tools.ReadText.execute({ start: result.nextPosition, maxUnits: 3, revision });
      all += result.content;
    }
    expect(all).toBe("ab\r\n😀cd");
    editor.insertText("changed");
    expect(() => tools.ReadText.execute({ revision })).toThrowError(/revision changed/);
  });

  it("preflights replaced text before mutation and supports explicit omission", async () => {
    const source = hugeSource();
    const args = {
      text: "short",
      start: { row: 0, column: 0 },
      end: { row: 0, column: source.length },
    };
    const refused = await executeTool("WriteText", args);
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("budget");
    expect(editor.getBuffer().getTextSnapshot().equals(source)).toBe(true);
    expect(editor.getBuffer().undo()).toBe(false);
    const accepted = await executeTool("WriteText", { ...args, returnOldText: false });
    expect(accepted.data.written).toBe(true);
    expect(Object.hasOwn(accepted.data, "oldText")).toBe(false);
    expect(editor.getText()).toBe("short");
    editor.undo();
    expect(editor.getBuffer().getTextSnapshot().equals(source)).toBe(true);
  });

  it("returns huge selection metadata without reading selection text", () => {
    const source = hugeSource();
    editor.selectAll();
    const selected = spyOn(editor.getLastSelection(), "getText").and.throwError(
      "Selection text read",
    );
    try {
      expect(() => tools.GetSelections.execute()).toThrowError(/budget/);
      const result = tools.GetSelections.execute({ includeText: false });
      expect(result[0].length).toBe(source.length);
      expect(Object.hasOwn(result[0], "text")).toBe(false);
    } finally {
      selected.and.callThrough();
    }
  });
});
