/**
 * Tool definitions for Lumine MCP server
 * Each tool contains: name, description, inputSchema, execute
 */

const fs = require("fs");
const pathModule = require("path");
const TEXT_BUDGET = 1024 * 1024;
const SELECTION_BUDGET = 2000;

function textLength(editor, range) {
  const buffer = editor.getBuffer();
  const clipped = buffer.clipRange(range);
  return (
    buffer.characterIndexForPosition(clipped.end) - buffer.characterIndexForPosition(clipped.start)
  );
}

function checkTextBudget(length, operation) {
  if (length > TEXT_BUDGET)
    throw new RangeError(
      `${operation} exceeds the 1 Mi UTF-16 text budget. Use ReadText pagination or omit returned selection/replaced text.`,
    );
}

function readTextResult(editor, range, maxUnits, more = false) {
  const buffer = editor.getBuffer();
  range = buffer.clipRange(range);
  const source = buffer.getTextSnapshot();
  const start = buffer.characterIndexForPosition(range.start);
  const end = buffer.characterIndexForPosition(range.end);
  let pageEnd = Math.min(end, start + maxUnits);
  if (pageEnd < end) {
    const before = source.charCodeAt(pageEnd - 1),
      after = source.charCodeAt(pageEnd);
    if (
      (before === 13 && after === 10) ||
      (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
    )
      pageEnd--;
  }
  const finish = buffer.positionForCharacterIndex(pageEnd);
  const position = (point) => ({ row: point.row, column: point.column });
  const hasMore = pageEnd < end || more;
  return {
    content: source.slice(start, pageEnd),
    path: editor.getPath() || null,
    fileState: editor.getFileState(),
    totalLines: editor.getLineCount(),
    revision: buffer.getTextRevision(),
    hasMore,
    nextPosition: hasMore ? position(finish) : null,
    range: { start: position(range.start), end: position(finish) },
  };
}

// ============================================================================
// Tool Definitions
// ============================================================================

function getProjectRootPaths() {
  return lumine.project.getDirectories().map((directory) => directory.getPath());
}

function findExistingPath(filePath) {
  if (pathModule.isAbsolute(filePath)) {
    return fs.existsSync(filePath) ? filePath : null;
  }

  for (const projectPath of getProjectRootPaths()) {
    const candidate = pathModule.join(projectPath, filePath);
    if (fs.existsSync(candidate)) return candidate;
  }

  return fs.existsSync(filePath) ? filePath : null;
}

function resolvePathForCreate(filePath) {
  if (pathModule.isAbsolute(filePath)) return filePath;
  const [projectPath] = getProjectRootPaths();
  return projectPath ? pathModule.join(projectPath, filePath) : filePath;
}

/**
 * Compare two paths the way the filesystem does.
 *
 * A caller is a model, and it writes `c:/foo/bar.js` as readily as
 * `C:\foo\bar.js`. Comparing what it sent to what the editor holds with ===
 * meant the second spelling silently found nothing on Windows.
 */
function samePath(left, right) {
  if (!left || !right) return false;
  const normalize = (value) => pathModule.normalize(value).replace(/[\\/]+$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Every path a caller might have meant by this one. A relative path is tried
 * against each project root, and against the working directory last.
 */
function candidatePaths(filePath) {
  if (pathModule.isAbsolute(filePath)) return [filePath];
  return [
    ...getProjectRootPaths().map((root) => pathModule.join(root, filePath)),
    pathModule.resolve(filePath),
  ];
}

/**
 * The open editor a path names, or null. With no path, the active one.
 */
function editorForPath(filePath) {
  if (!filePath) return lumine.workspace.getActiveTextEditor() || null;
  const candidates = candidatePaths(filePath);
  return (
    lumine.workspace
      .getTextEditors()
      .find((editor) => candidates.some((candidate) => samePath(editor.getPath(), candidate))) ||
    null
  );
}

async function saveEditor(editor) {
  const pane = lumine.workspace.paneForItem(editor);
  if (!pane) {
    await editor.save();
    return true;
  }
  let completed = false;
  let failure;
  try {
    await pane.saveItem(editor, (error) => {
      if (error) failure = error;
      else completed = true;
    });
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    if (["SaveCancelledError", "SaveConflictedError"].includes(failure.name)) return false;
    throw failure;
  }
  return completed;
}

const tools = {
  GetActiveEditor: {
    name: "GetActiveEditor",
    title: "Get Active Editor",
    description:
      "Get active editor metadata. Returns {path, grammar, fileState, lineCount}, or null when no text editor is active. Use ReadText for content, GetSelections for cursors/selections.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute() {
      const editor = lumine.workspace.getActiveTextEditor();
      if (!editor) return null;
      return {
        path: editor.getPath() || null,
        grammar: editor.getGrammar()?.name || "Plain Text",
        fileState: editor.getFileState(),
        lineCount: editor.getLineCount(),
      };
    },
  },

  GetOpenEditors: {
    name: "GetOpenEditors",
    title: "Get Open Editors",
    description:
      "Get metadata for all open text editors. Returns an array of {path, grammar, fileState, lineCount, active}, empty when none are open. When fileState is not unmodified, read the open buffer with ReadText rather than assuming the disk contains what the user sees.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute() {
      const activeEditor = lumine.workspace.getActiveTextEditor();
      return lumine.workspace.getTextEditors().map((editor) => ({
        path: editor.getPath() || null,
        grammar: editor.getGrammar()?.name || "Plain Text",
        fileState: editor.getFileState(),
        lineCount: editor.getLineCount(),
        active: editor === activeEditor,
      }));
    },
  },

  ReadText: {
    name: "ReadText",
    title: "Read Text",
    description:
      "Read an open editor's buffer, including unsaved changes. Select offset/limit lines, start/end positions, or omit both to start at the beginning. Each page contains at most maxUnits (default 1 Mi UTF-16 units). Returns {content,path,totalLines,fileState,range,revision,hasMore,nextPosition}. Continue with start:nextPosition and revision; preserve an explicit end if supplied. A changed revision rejects the next page. All positions are 0-indexed. Returns null when no editor matches.",
    inputSchema: {
      type: "object",
      properties: {
        maxUnits: {
          type: "integer",
          minimum: 2,
          maximum: TEXT_BUDGET,
          description:
            "Maximum UTF-16 units in one page; CRLF and surrogate pairs are kept together.",
        },
        revision: {
          type: "integer",
          description: "Expected document revision from a previous page.",
        },
        path: {
          type: "string",
          description:
            "The open file to read, absolute or relative to a project root. Omit for the editor the user is in.",
        },
        offset: {
          type: "number",
          description: "Start line for pagination (0-indexed). Use with limit for chunked reading.",
        },
        limit: {
          type: "number",
          description:
            "Max lines to read (recommended: <500). Returns hasMore=true if more lines exist.",
        },
        start: {
          type: "object",
          description: "Start position (0-indexed). If omitted, reads from beginning.",
          properties: {
            row: { type: "number", description: "Row (0-indexed)" },
            column: { type: "number", description: "Column (0-indexed)" },
          },
          required: ["row", "column"],
        },
        end: {
          type: "object",
          description: "End position (0-indexed). If omitted, reads to end of file.",
          properties: {
            row: { type: "number", description: "Row (0-indexed)" },
            column: { type: "number", description: "Column (0-indexed)" },
          },
          required: ["row", "column"],
        },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute({
      path: requestedPath,
      offset,
      limit,
      start,
      end,
      maxUnits = TEXT_BUDGET,
      revision,
    } = {}) {
      const editor = editorForPath(requestedPath);
      if (!editor) return null;
      if (!Number.isSafeInteger(maxUnits) || maxUnits < 2 || maxUnits > TEXT_BUDGET)
        throw new RangeError("maxUnits must be between 2 and 1,048,576");
      if (revision !== undefined && revision !== editor.getBuffer().getTextRevision())
        throw new Error("Document revision changed; restart pagination.");
      const totalLines = editor.getLineCount();
      const lastRow = editor.getLastBufferRow();
      const endOfRow = (row) => editor.getBuffer().lineLengthForRow(row) ?? 0;

      // Line-based pagination (offset/limit)
      if (offset !== undefined || limit !== undefined) {
        if ([offset, limit].some((value) => value !== undefined && !Number.isSafeInteger(value)))
          throw new RangeError("offset and limit must be safe integer line counts");
        // Clamped rather than trusted: an offset past the end used to build a
        // range whose end came before its start, which the buffer then read
        // backwards and answered with the wrong lines.
        const startLine = Math.min(Math.max(offset || 0, 0), lastRow);
        const requested = limit === undefined ? totalLines : Math.max(limit, 0);
        const endLine = Math.min(startLine + requested, totalLines);
        const lastLine = Math.max(endLine - 1, startLine);
        const range = [
          [startLine, 0],
          requested === 0 ? [startLine, 0] : [lastLine, endOfRow(lastLine)],
        ];
        return readTextResult(editor, range, maxUnits, endLine < totalLines);
      }

      // Position-based range
      if (start || end) {
        const s = start || { row: 0, column: 0 };
        const e = end || { row: lastRow, column: endOfRow(lastRow) };
        const range = [
          [s.row, s.column],
          [e.row, e.column],
        ];
        return readTextResult(editor, range, maxUnits);
      }

      // Return full content
      return readTextResult(editor, editor.getBuffer().getRange(), maxUnits);
    },
  },

  WriteText: {
    name: "WriteText",
    title: "Write Text",
    description:
      "Write into an open editor's buffer, leaving changes unsaved for review. With start: insert at that position; with start+end: replace that range; otherwise insert at cursors. Input text and returned oldText each have a 1 Mi UTF-16 budget. Set returnOldText:false to replace arbitrarily large ranges without returning their contents. Returns {written:true,path,oldText?}, or {written:false} when no editor matches. Limits are checked before mutation.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text to write",
        },
        returnOldText: {
          type: "boolean",
          default: true,
          description:
            "Return replaced text for an explicit range. Disable for ranges larger than the response budget.",
        },
        path: {
          type: "string",
          description:
            "The open file to write into, absolute or relative to a project root. Omit for the editor the user is in.",
        },
        start: {
          type: "object",
          description: "Start position (0-indexed). If omitted, inserts at cursor.",
          properties: {
            row: { type: "number", description: "Row (0-indexed)" },
            column: { type: "number", description: "Column (0-indexed)" },
          },
          required: ["row", "column"],
        },
        end: {
          type: "object",
          description: "End position (0-indexed). Defaults to start (insert without replacing).",
          properties: {
            row: { type: "number", description: "Row (0-indexed)" },
            column: { type: "number", description: "Column (0-indexed)" },
          },
          required: ["row", "column"],
        },
      },
      required: ["text"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    execute({ text, path, start, end, returnOldText = true }) {
      if (typeof text !== "string") throw new Error("text is required");
      checkTextBudget(text.length, "WriteText input");

      const editor = editorForPath(path);
      if (!editor) return { written: false };

      // If start specified, insert/replace at position
      if (start) {
        const e = end || start; // Default end to start (insert without replacing)
        const range = [
          [start.row, start.column],
          [e.row, e.column],
        ];
        if (returnOldText) checkTextBudget(textLength(editor, range), "WriteText replaced text");
        const oldText = returnOldText ? editor.getTextInBufferRange(range) : undefined;
        editor.setTextInBufferRange(range, text);
        return {
          written: true,
          ...(returnOldText ? { oldText } : {}),
          path: editor.getPath() || null,
        };
      }

      // Otherwise insert at cursor/replace selection
      editor.insertText(text);
      return { written: true, path: editor.getPath() || null };
    },
  },

  OpenFile: {
    name: "OpenFile",
    title: "Open File",
    description:
      "Open a file in the editor. All positions are 0-indexed. Set create=true to open a new buffer for a missing path; SaveFile persists it. Returns {opened: true, path, created}, {opened: false, path} when the editor declines, or {opened: false, error: 'file_not_found', path} when a file is missing and create is false.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path (absolute or relative to project root)",
        },
        row: {
          type: "number",
          description: "Row to navigate to (0-indexed, optional)",
        },
        column: {
          type: "number",
          description: "Column to navigate to (0-indexed, optional)",
        },
        create: {
          type: "boolean",
          description: "Create the file if it does not exist (default: false)",
        },
      },
      required: ["path"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute({ path, row, column, create = false }) {
      if (typeof path !== "string") throw new Error("path is required");
      const existingPath = findExistingPath(path);
      if (!existingPath && !create) {
        return { opened: false, error: "file_not_found", path };
      }

      const targetPath = existingPath || resolvePathForCreate(path);
      const options = {};
      if (row !== undefined) {
        options.initialLine = row;
        if (column !== undefined) {
          options.initialColumn = column;
        }
      }
      const opened = await lumine.workspace.open(targetPath, options);
      if (!opened) return { opened: false, path: targetPath };
      return { opened: true, path: targetPath, created: !existingPath };
    },
  },

  SaveFile: {
    name: "SaveFile",
    title: "Save File",
    description:
      "Save a file through the editor's normal save flow, including Save As and conflict prompts. If path omitted, saves the active editor. Paths are case-insensitive on Windows, exact on POSIX; relative paths resolve against project roots. Returns {saved: true, path}, or {saved: false} when no editor matches or the user cancels.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path to save (optional, defaults to active editor)",
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute({ path }) {
      const editor = editorForPath(path);
      if (!editor) return { saved: false };
      if (!(await saveEditor(editor))) return { saved: false };
      return { saved: true, path: editor.getPath() || null };
    },
  },

  CloseFile: {
    name: "CloseFile",
    title: "Close File",
    description:
      "Close an editor tab and await its close listeners. If path omitted, closes the active editor. Unsaved changes are discarded unless save=true; saving then honors normal editor prompts and preserves any newer unsaved edits. Path matching follows SaveFile. Returns {closed: true, path}, or {closed: false} when no editor matches, saving is cancelled or closing is prevented.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path to close (optional, defaults to active editor)",
        },
        save: {
          type: "boolean",
          description: "Save before closing if the file state is not unmodified (default: false)",
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute({ path, save = false }) {
      const editor = editorForPath(path);
      if (!editor) return { closed: false };

      const pane = lumine.workspace.paneForItem(editor);
      if (!pane) return { closed: false };

      if (save && editor.getFileState() !== "unmodified") {
        if (!(await saveEditor(editor)) || editor.getFileState() !== "unmodified")
          return { closed: false };
      }

      const closedPath = editor.getPath() || null;
      const closed = await pane.destroyItem(editor, true, {
        canDestroy: () => !save || editor.getFileState() === "unmodified",
      });
      return closed ? { closed: true, path: closedPath } : { closed: false };
    },
  },

  GetSelections: {
    name: "GetSelections",
    title: "Get Selections",
    description:
      "Get selections/cursors, primary first, with 0-indexed ranges. Returns [{text,isEmpty,range}], or null without an editor. The aggregate text budget is 1 Mi UTF-16 units and at most 2,000 selections. Set includeText:false to return {length,isEmpty,range} for arbitrarily large selected ranges, then use ReadText pagination.",
    inputSchema: {
      type: "object",
      properties: { includeText: { type: "boolean", default: true } },
      required: [],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute({ includeText = true } = {}) {
      const editor = lumine.workspace.getActiveTextEditor();
      if (!editor) return null;
      const selections = editor.getSelections();
      if (selections.length > SELECTION_BUDGET)
        throw new RangeError("GetSelections is limited to 2,000 selections.");
      if (includeText)
        checkTextBudget(
          selections.reduce(
            (sum, selection) => sum + textLength(editor, selection.getBufferRange()),
            0,
          ),
          "Selected text",
        );
      return selections.reverse().map((selection) => {
        const range = selection.getBufferRange();
        return {
          ...(includeText ? { text: selection.getText() } : { length: textLength(editor, range) }),
          isEmpty: selection.isEmpty(),
          range: {
            start: { row: range.start.row, column: range.start.column },
            end: { row: range.end.row, column: range.end.column },
          },
        };
      });
    },
  },

  SetSelections: {
    name: "SetSelections",
    title: "Set Selections",
    description:
      "Set selections/cursors in active editor. All positions are 0-indexed. If end equals start (or omitted), places cursor without selection. First selection becomes primary. Returns {set: true, count: number} on success, {set: false} if no editor.",
    inputSchema: {
      type: "object",
      properties: {
        selections: {
          type: "array",
          description: "Array of selection ranges to set",
          items: {
            type: "object",
            properties: {
              start: {
                type: "object",
                description: "Start position (0-indexed)",
                properties: {
                  row: { type: "number", description: "Row (0-indexed)" },
                  column: { type: "number", description: "Column (0-indexed)" },
                },
                required: ["row", "column"],
              },
              end: {
                type: "object",
                description:
                  "End position (0-indexed). Omit or set equal to start for cursor-only.",
                properties: {
                  row: { type: "number", description: "Row (0-indexed)" },
                  column: { type: "number", description: "Column (0-indexed)" },
                },
                required: ["row", "column"],
              },
            },
            required: ["start"],
          },
          minItems: 1,
        },
      },
      required: ["selections"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute({ selections }) {
      if (!Array.isArray(selections) || selections.length === 0) {
        throw new Error("selections array is required and must not be empty");
      }
      if (selections.length > SELECTION_BUDGET)
        throw new RangeError("SetSelections is limited to 2,000 selections.");

      const editor = lumine.workspace.getActiveTextEditor();
      if (!editor) return { set: false };

      // Clear existing selections and set new ones
      const ranges = selections.map((sel) => {
        const start = sel.start;
        const end = sel.end || sel.start;
        return [
          [start.row, start.column],
          [end.row, end.column],
        ];
      });

      editor.setSelectedBufferRanges(ranges.reverse());
      return { set: true, count: selections.length };
    },
  },

  GetProjectPaths: {
    name: "GetProjectPaths",
    title: "Get Project Paths",
    description:
      "Get project root folders. Returns string[] of absolute paths. Empty array if no project open.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute() {
      return lumine.project.getPaths();
    },
  },

  AddProjectPath: {
    name: "AddProjectPath",
    title: "Add Project Path",
    description:
      "Add a folder to project roots without removing existing paths. Returns {added: true, path}, {added: false, error: 'not_a_directory'} when the path is not an existing folder, or {added: false, error: 'already_a_project_root'} when it is already one.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute folder path to add",
        },
      },
      required: ["path"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute({ path }) {
      if (typeof path !== "string") throw new Error("path is required");

      // The description promised this check and there never was one: any
      // string at all was answered with {added: true}.
      const resolved = pathModule.resolve(path);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return { added: false, error: "not_a_directory", path };
      }
      if (lumine.project.getPaths().some((root) => samePath(root, resolved))) {
        return { added: false, error: "already_a_project_root", path: resolved };
      }

      lumine.project.addPath(resolved);
      return { added: true, path: resolved };
    },
  },

  RemoveProjectPath: {
    name: "RemoveProjectPath",
    title: "Remove Project Path",
    description:
      "Remove a folder from project roots. Returns {removed: true, path}, or {removed: false} when the path is not a project root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute folder path to remove",
        },
      },
      required: ["path"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    execute({ path }) {
      if (typeof path !== "string") throw new Error("path is required");
      // Matched the way the filesystem would, so a root spelled differently
      // from the way the editor holds it still comes off.
      const root = lumine.project.getPaths().find((candidate) => samePath(candidate, path));
      if (!root) return { removed: false };
      lumine.project.removePath(root);
      return { removed: true, path: root };
    },
  },
};

// ============================================================================
// Exports
// ============================================================================

/**
 * Get tool metadata for MCP protocol (name, description, inputSchema)
 */
function getToolsList() {
  return Object.values(tools).map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations,
  }));
}

/**
 * Execute a builtin tool by name
 */
async function executeTool(toolName, args = {}) {
  const tool = getToolByName(toolName);
  if (!tool) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  try {
    const data = await tool.execute(args);
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Get tool definition by name
 */
function getToolByName(name) {
  return Object.hasOwn(tools, name) ? tools[name] : null;
}

module.exports = { tools, getToolsList, executeTool, getToolByName };
