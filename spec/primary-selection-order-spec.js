const path = require("node:path");

describe("MCP primary selection ordering", () => {
  let editor, tools;

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.returnValue(Promise.resolve());
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    lumine.config.set("lumine-mcp.autoStart", false);
    const pack = await lumine.packages.activatePackage("lumine-mcp");
    ({ tools } = require(path.join(pack.path, "lib/tools")));
    editor = await lumine.workspace.open();
    editor.setText("alpha\nbeta\ngamma\n");
    jasmine.attachToDOM(lumine.workspace.getElement());
  });

  afterEach(async () => {
    editor?.destroy();
    if (lumine.packages.isPackageActive("lumine-mcp"))
      await lumine.packages.deactivatePackage("lumine-mcp");
    if (lumine.packages.isPackageLoaded("lumine-mcp"))
      await lumine.packages.unloadPackage("lumine-mcp");
    lumine.config.unset("lumine-mcp.autoStart");
    editor = tools = null;
  });

  it("returns the editor's actual primary selection first", () => {
    editor.setSelectedBufferRanges([
      [
        [0, 1],
        [0, 3],
      ],
      [
        [2, 2],
        [2, 4],
      ],
    ]);
    const primary = editor.getLastSelection();
    const result = tools.GetSelections.execute();
    expect(result.length).toBe(2);
    const range = primary.getBufferRange();
    expect(result[0].range.start).toEqual({ row: range.start.row, column: range.start.column });
    expect(result[0].range.end).toEqual({ row: range.end.row, column: range.end.column });
    expect(result[0].text).toBe("mm");
    expect(result[1].text).toBe("lp");
  });

  it("makes the first supplied selection the actual primary without mutating the input", () => {
    const selections = Object.freeze([
      Object.freeze({ start: { row: 1, column: 1 }, end: { row: 1, column: 3 } }),
      Object.freeze({ start: { row: 2, column: 2 }, end: { row: 2, column: 4 } }),
    ]);
    expect(tools.SetSelections.execute({ selections })).toEqual({ set: true, count: 2 });
    expect(editor.getLastSelection().getBufferRange().serialize()).toEqual([
      [1, 1],
      [1, 3],
    ]);
    expect(editor.getLastSelection().getText()).toBe("et");
    expect(selections[0].start).toEqual({ row: 1, column: 1 });
  });

  it("keeps ordinary single-cursor behavior", () => {
    expect(tools.SetSelections.execute({ selections: [{ start: { row: 1, column: 2 } }] })).toEqual(
      { set: true, count: 1 },
    );
    expect(editor.getCursorBufferPosition().serialize()).toEqual([1, 2]);
    expect(tools.GetSelections.execute()).toEqual([
      {
        text: "",
        isEmpty: true,
        range: { start: { row: 1, column: 2 }, end: { row: 1, column: 2 } },
      },
    ]);
  });
});
