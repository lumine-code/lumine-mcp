/**
 * Tool definitions for Lumine MCP server
 * Each tool contains: name, description, inputSchema, execute
 */

const fs = require("fs");
const pathModule = require("path");
const { FileState } = require("lumine");

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
      "Read an open editor's buffer, which is what the user is looking at. Reach for this when GetOpenEditors reports a fileState other than unmodified: the disk may not contain what the user sees. Modes: (1) offset/limit, which also returns hasMore. (2) start/end positions. (3) No params = whole buffer. Returns {content, path, totalLines, fileState, range} in every mode, where range is {start: {row, column}, end: {row, column}} 0-indexed, or null when the path names no open editor and no editor is active.",
    inputSchema: {
      type: "object",
      properties: {
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
    execute({ path: requestedPath, offset, limit, start, end } = {}) {
      const editor = editorForPath(requestedPath);
      if (!editor) return null;

      const path = editor.getPath() || null;
      const fileState = editor.getFileState();
      const totalLines = editor.getLineCount();
      const lastRow = editor.getLastBufferRow();
      const endOfRow = (row) => editor.lineTextForBufferRow(row)?.length ?? 0;
      const position = (row, column) => ({ row, column });

      // Line-based pagination (offset/limit)
      if (offset !== undefined || limit !== undefined) {
        // Clamped rather than trusted: an offset past the end used to build a
        // range whose end came before its start, which the buffer then read
        // backwards and answered with the wrong lines.
        const startLine = Math.min(Math.max(offset || 0, 0), lastRow);
        const requested = limit === undefined ? totalLines : Math.max(limit, 0);
        const endLine = Math.min(startLine + requested, totalLines);
        const lastLine = Math.max(endLine - 1, startLine);
        const range = [
          [startLine, 0],
          [lastLine, endOfRow(lastLine)],
        ];
        return {
          content: requested === 0 ? "" : editor.getTextInBufferRange(range),
          path,
          fileState,
          totalLines,
          hasMore: endLine < totalLines,
          range: {
            start: position(startLine, 0),
            end: position(lastLine, endOfRow(lastLine)),
          },
        };
      }

      // Position-based range
      if (start || end) {
        const s = start || { row: 0, column: 0 };
        const e = end || { row: lastRow, column: endOfRow(lastRow) };
        const range = [
          [s.row, s.column],
          [e.row, e.column],
        ];
        return {
          content: editor.getTextInBufferRange(range),
          path,
          fileState,
          totalLines,
          range: { start: position(s.row, s.column), end: position(e.row, e.column) },
        };
      }

      // Return full content
      return {
        content: editor.getText(),
        path,
        fileState,
        totalLines,
        range: { start: position(0, 0), end: position(lastRow, endOfRow(lastRow)) },
      };
    },
  },

  WriteText: {
    name: "WriteText",
    title: "Write Text",
    description:
      "Write into an open editor's buffer, leaving the change unsaved for the user to review. Reach for this when the file has unsaved changes, or when the user should see the edit before it reaches disk; for an ordinary edit to a saved file, use your own file tools, which are better at it. With start: inserts at position (end defaults to start). With start+end: replaces range. Without either: inserts at the cursors, replacing any selection. Returns {written: true, path} — plus oldText when a range was replaced — or {written: false} when the path names no open editor and no editor is active.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text to write",
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
    execute({ text, path, start, end }) {
      if (typeof text !== "string") throw new Error("text is required");

      const editor = editorForPath(path);
      if (!editor) return { written: false };

      // If start specified, insert/replace at position
      if (start) {
        const e = end || start; // Default end to start (insert without replacing)
        const range = [
          [start.row, start.column],
          [e.row, e.column],
        ];
        const oldText = editor.getTextInBufferRange(range);
        editor.setTextInBufferRange(range, text);
        return { written: true, oldText, path: editor.getPath() || null };
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
      "Open an existing file in editor. All positions are 0-indexed. Set create=true to create a new file if path doesn't exist. Returns {opened: true, path, created}, or {opened: false, error: 'file_not_found', path} when the file does not exist and create is false.",
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
      await lumine.workspace.open(targetPath, options);
      return { opened: true, path: targetPath, created: !existingPath };
    },
  },

  SaveFile: {
    name: "SaveFile",
    title: "Save File",
    description:
      "Save a file. If path omitted, saves the active editor. Path matching follows the filesystem: case-insensitive and separator-agnostic on Windows, exact on POSIX, and a relative path is resolved against the project roots. Returns {saved: true, path}, or {saved: false} when the path names no open editor and no editor is active.",
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
      await editor.save();
      return { saved: true, path: editor.getPath() || null };
    },
  },

  CloseFile: {
    name: "CloseFile",
    title: "Close File",
    description:
      "Close an editor tab. If path omitted, closes the active editor. Unsaved changes are discarded unless save=true. Path matching follows the filesystem, as with SaveFile. Returns {closed: true, path}, or {closed: false} when the path names no open editor and no editor is active.",
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

      if (save && editor.getFileState() !== FileState.UNMODIFIED) {
        await editor.save();
      }

      const closedPath = editor.getPath() || null;
      pane.destroyItem(editor, true);
      return { closed: true, path: closedPath };
    },
  },

  GetSelections: {
    name: "GetSelections",
    title: "Get Selections",
    description:
      "Get all selections/cursors. Returns array of {text: string, isEmpty: boolean, range: {start: {row, column}, end: {row, column}}} (0-indexed). First element is primary selection. Returns null if no editor.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute() {
      const editor = lumine.workspace.getActiveTextEditor();
      if (!editor) return null;

      return editor.getSelections().map((selection) => {
        const range = selection.getBufferRange();
        return {
          text: selection.getText(),
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

      editor.setSelectedBufferRanges(ranges);
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
  const tool = tools[toolName];
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
  return tools[name] || null;
}

module.exports = { tools, getToolsList, executeTool, getToolByName };
