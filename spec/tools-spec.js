const fs = require("fs");
const os = require("os");
const path = require("path");
const { executeTool } = require("../lib/tools");

describe("lumine-mcp builtin tools", () => {
  let directory, filePath;

  const run = async (name, args = {}) => {
    const result = await executeTool(name, args);
    if (!result.success) throw new Error(`${name} failed: ${result.error}`);
    return result.data;
  };

  beforeEach(() => {
    // Realpathed: on macOS the temp directory is reached through a symlink,
    // and the editor reports the resolved path rather than the one given.
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lumine-mcp-tools-")));
    filePath = path.join(directory, "sample.js");
    fs.writeFileSync(filePath, "one\ntwo\nthree\nfour\nfive\n");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  describe("finding an editor by path", () => {
    beforeEach(async () => {
      await lumine.workspace.open(filePath);
    });

    // A model writes a path however it happens to have it, and === against
    // what the editor holds used to answer "no such editor" without a word.
    it("matches a path spelled differently from the way the editor holds it", async () => {
      const awkward = path.join(directory, ".", "sample.js").replace(/\\/g, "/");
      expect(await run("SaveFile", { path: awkward })).toEqual({ saved: true, path: filePath });
    });

    if (process.platform === "win32") {
      it("matches case-insensitively on Windows, as the filesystem does", async () => {
        const shouted = filePath.toUpperCase();
        expect((await run("SaveFile", { path: shouted })).saved).toBe(true);
      });
    }

    it("matches a path relative to a project root", async () => {
      lumine.project.setPaths([directory]);
      expect((await run("SaveFile", { path: "sample.js" })).saved).toBe(true);
    });

    it("says so plainly when nothing matches", async () => {
      const answer = await run("SaveFile", { path: path.join(directory, "absent.js") });
      expect(answer).toEqual({ saved: false });
    });

    it("closes the editor a path names", async () => {
      lumine.config.set("lumine-mcp.toolList", []);
      const answer = await run("CloseFile", { path: filePath.replace(/\\/g, "/") });
      expect(answer.closed).toBe(true);
      expect(lumine.workspace.getTextEditors().length).toBe(0);
    });
  });

  // The one thing these two do that the agent's own file tools cannot: read
  // and write what the user has in front of them but has not saved. Reading
  // such a file from disk answers with content the user has already changed,
  // and writing it there throws that work away.
  describe("unsaved buffers", () => {
    let other, otherPath;

    beforeEach(async () => {
      otherPath = path.join(directory, "other.js");
      fs.writeFileSync(otherPath, "on disk\n");
      other = await lumine.workspace.open(otherPath);
      other.setText("in the buffer\n");
      // Opened second, then left behind: the point is that neither tool needs
      // the file it acts on to be the one the user is looking at.
      await lumine.workspace.open(filePath);
    });

    it("reads a modified buffer the user is not looking at", async () => {
      const answer = await run("ReadText", { path: otherPath });
      expect(answer.content).toBe("in the buffer\n");
      expect(answer.fileState).toBe("modified");
      expect(answer.path).toBe(otherPath);
      expect(fs.readFileSync(otherPath, "utf8")).toBe("on disk\n");
    });

    it("still reads the active editor when given no path", async () => {
      expect((await run("ReadText")).path).toBe(filePath);
    });

    it("reports a buffer that matches its file as unmodified", async () => {
      expect((await run("ReadText", { path: filePath })).fileState).toBe("unmodified");
    });

    it("writes into a buffer the user is not looking at", async () => {
      const answer = await run("WriteText", {
        path: otherPath,
        text: "written\n",
        start: { row: 0, column: 0 },
        end: { row: 0, column: 13 },
      });
      expect(answer.written).toBe(true);
      expect(answer.oldText).toBe("in the buffer");
      expect(other.getText()).toBe("written\n\n");
      // Left unsaved, for the user to look at before it reaches disk.
      expect(fs.readFileSync(otherPath, "utf8")).toBe("on disk\n");
    });

    it("says so plainly when the path names no open editor", async () => {
      const absent = { path: path.join(directory, "closed.js"), text: "x" };
      expect(await run("ReadText", { path: absent.path })).toBeNull();
      expect(await run("WriteText", absent)).toEqual({ written: false });
    });

    // GetOpenEditors is where a caller learns it must not read from disk.
    it("reports which open files hold unsaved work", async () => {
      const dirty = (await run("GetOpenEditors")).filter(
        (editor) => editor.fileState !== "unmodified",
      );
      expect(dirty.map((editor) => editor.path)).toEqual([otherPath]);
    });
  });

  describe("ReadText", () => {
    beforeEach(async () => {
      await lumine.workspace.open(filePath);
    });

    // The same field used to be {start: number, end: number} when paginating
    // and {start: {row, column}, …} when not, which nothing could rely on.
    it("reports its range as positions whichever way it is called", async () => {
      const shapes = [
        await run("ReadText", { offset: 1, limit: 2 }),
        await run("ReadText", { start: { row: 0, column: 0 }, end: { row: 1, column: 3 } }),
        await run("ReadText"),
      ];
      for (const answer of shapes) {
        expect(typeof answer.range.start.row).toBe("number");
        expect(typeof answer.range.start.column).toBe("number");
        expect(typeof answer.range.end.row).toBe("number");
        expect(typeof answer.range.end.column).toBe("number");
      }
    });

    it("pages through a file and says when there is more", async () => {
      const first = await run("ReadText", { offset: 0, limit: 2 });
      expect(first.content).toBe("one\ntwo");
      expect(first.hasMore).toBe(true);

      const last = await run("ReadText", { offset: 4, limit: 2 });
      expect(last.content).toBe("five\n");
      expect(last.hasMore).toBe(false);
    });

    // Both used to build a range whose end came before its start, which the
    // buffer read backwards and answered with lines nobody asked for.
    it("answers an offset past the end without reading backwards", async () => {
      const answer = await run("ReadText", { offset: 500, limit: 10 });
      expect(answer.range.start.row).toBeLessThan(answer.totalLines);
      expect(answer.range.end.row).toBeGreaterThanOrEqual(answer.range.start.row);
      expect(answer.hasMore).toBe(false);
    });

    it("reads nothing for a limit of nothing", async () => {
      const answer = await run("ReadText", { offset: 0, limit: 0 });
      expect(answer.content).toBe("");
      expect(answer.hasMore).toBe(true);
    });
  });

  describe("project paths", () => {
    beforeEach(() => {
      lumine.project.setPaths([]);
    });

    // The description promised this check and there never was one: any string
    // at all was answered with {added: true}.
    it("refuses a path that is not a directory", async () => {
      expect(await run("AddProjectPath", { path: filePath })).toEqual({
        added: false,
        error: "not_a_directory",
        path: filePath,
      });
      expect(await run("AddProjectPath", { path: path.join(directory, "nowhere") })).toEqual({
        added: false,
        error: "not_a_directory",
        path: path.join(directory, "nowhere"),
      });
      expect(lumine.project.getPaths()).toEqual([]);
    });

    it("adds a directory once", async () => {
      expect(await run("AddProjectPath", { path: directory })).toEqual({
        added: true,
        path: directory,
      });
      expect(await run("AddProjectPath", { path: directory })).toEqual({
        added: false,
        error: "already_a_project_root",
        path: directory,
      });
      expect(lumine.project.getPaths()).toEqual([directory]);
    });

    it("removes a root spelled differently from the way it was added", async () => {
      lumine.config.set("lumine-mcp.toolList", []);
      lumine.project.setPaths([directory]);
      const awkward = path.join(directory, ".").replace(/\\/g, "/");
      expect(await run("RemoveProjectPath", { path: awkward })).toEqual({
        removed: true,
        path: directory,
      });
      expect(lumine.project.getPaths()).toEqual([]);
    });

    it("reports a root it does not hold", async () => {
      expect(await run("RemoveProjectPath", { path: directory })).toEqual({ removed: false });
    });
  });

  describe("every tool's declared behaviour", () => {
    const { tools } = require("../lib/tools");

    it("says whether it writes, and what that means if it does", () => {
      for (const tool of Object.values(tools)) {
        expect(typeof tool.title).toBe("string");
        expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
        expect(tool.annotations.openWorldHint).toBe(false);
        if (tool.annotations.readOnlyHint) continue;
        // destructiveHint defaults to true, so a writing tool that leaves it
        // out is described to a host as destructive whether it is or not.
        expect(typeof tool.annotations.destructiveHint).toBe("boolean");
        expect(typeof tool.annotations.idempotentHint).toBe("boolean");
      }
    });
  });
});
