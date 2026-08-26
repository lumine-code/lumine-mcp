# lumine-mcp

Model Context Protocol server exposing editor tools to AI assistants.

## Features

- **MCP protocol**: speaks 2025-11-25, 2025-06-18 and 2025-03-26, negotiated per client, with tool annotations.
- **HTTP bridge**: server running inside each Lumine window for direct API access, reachable only after the user approves the client.
- **Standalone server**: stdio script for Claude CLI and other MCP hosts, connecting explicitly to the window the user names.
- **Editor tools**: get/set content, open/save files, manage selections.
- **Extensible**: other packages can register tools via `mcp.tools` service.
- **Live tool list**: clients are told when tools are registered, withdrawn, or switched off.
- **Toggle tools**: enable/disable individual tools via select list. Destructive tools disabled by default.

## Installation

To install `lumine-mcp` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/lumine-mcp`.

## Commands

Commands available in `lumine-workspace`:

- `lumine-mcp:toggle-tools`: toggle individual tools on/off,
- `lumine-mcp:start`: start the MCP bridge server,
- `lumine-mcp:stop`: stop the MCP bridge server,
- `lumine-mcp:status`: show current bridge status and port,
- `lumine-mcp:register-to-claude`: register the server globally with Claude Code,
- `lumine-mcp:register-to-codex`: register the server globally with Codex.

Commands available in `.lumine-mcp`:

- `lumine-mcp:toggle-mode`: switch blacklist/greenlist mode,
- `lumine-mcp:enable-all`: enable all tools,
- `lumine-mcp:disable-all`: disable all tools,
- `lumine-mcp:reset-defaults`: reset to defaults.

## Built-in Tools

| Tool                | Description                                                                             | Default  |
| ------------------- | --------------------------------------------------------------------------------------- | -------- |
| `GetActiveEditor`   | Get editor metadata (path, grammar, fileState, lineCount)                               | Enabled  |
| `GetOpenEditors`    | Get metadata for all open text editors                                                  | Enabled  |
| `ReadText`          | Read an open editor's buffer, including unsaved changes the file on disk does not have  | Enabled  |
| `WriteText`         | Write into an open editor's buffer, leaving the change unsaved for review               | Enabled  |
| `OpenFile`          | Open an existing file in editor with optional position (`create=true` allows new files) | Enabled  |
| `SaveFile`          | Save a file (active editor or specific path)                                            | Enabled  |
| `GetSelections`     | Get all selections/cursors with positions and text from active editor                   | Enabled  |
| `SetSelections`     | Set multiple selections/cursors at specific positions in active editor                  | Enabled  |
| `CloseFile`         | Close an editor tab                                                                     | Disabled |
| `GetProjectPaths`   | Get project root folders                                                                | Enabled  |
| `AddProjectPath`    | Add a folder to project roots                                                           | Enabled  |
| `RemoveProjectPath` | Remove a folder from project roots                                                      | Disabled |

A tool that takes a `path` matches it the way the filesystem does — case-insensitively and separator-agnostically on Windows, exactly on POSIX — and resolves a relative one against the project roots.

An assistant brings its own file tools, its own search and its own shell, and they are better than anything here at reading a file off disk. `ReadText` and `WriteText` are for the cases those tools get wrong: an open document whose `fileState` is `modified`, `conflicted`, or `removed`, where the disk does not hold what the user sees. `GetOpenEditors` reports that state for every editor.

Which tools are on is a list plus a mode. Under a **blacklist**, everything is on except what is listed, and a tool registered later arrives on; under a **greenlist**, only what is listed is on, and a tool registered later arrives off. Switching mode inverts the list with it, so the same tools stay on and only the default for a newcomer changes.

## Tools from other packages

Any package can publish tools of its own through the `mcp.tools` service, and they appear in the same list. Two do today:

- **linter** — `GetLinterMessages`, the diagnostics as the editor has them, filterable by file, severity and provider.
- **jupyter-repl** — `JupyterListKernels`, `JupyterExecute`, `JupyterInspect`, `JupyterInterrupt` and `JupyterRestart`, for the live kernel session. `JupyterExecute` and `JupyterRestart` are disabled by default: one runs code in the user's own session and the other discards it.

## MCP Client Integration

The standalone MCP server (`lib/server.js`) works with any MCP host that can spawn a command. It starts disconnected and offers `ConnectToLumine`; give that tool the port reported by `Lumine MCP: Status`, then approve the request in that Lumine window. Nothing chooses a window on the user's behalf, and losing one never redirects the agent into another.

The easiest setup is `lumine-mcp:register-to-claude` or `lumine-mcp:register-to-codex` from the command palette. Each command creates a global user entry named `lumine`, leaves an already-correct entry alone, and asks before replacing a different one. Start a new client session after registration.

### Claude Code

The editor command is preferred. Its manual equivalent on macOS/Linux is:

```bash
claude mcp add --scope user --transport stdio lumine -- node ~/.lumine/packages/lumine-mcp/lib/server.js
```

On Windows, in PowerShell:

```bash
claude mcp add --scope user --transport stdio lumine -- node "$env:USERPROFILE\.lumine\packages\lumine-mcp\lib\server.js"
```

Claude Code inherits `LUMINE_BRIDGE_PORT` when it is started from a Lumine terminal; the registration never stores a particular port.

### Codex

`Lumine MCP: Register to Codex` creates the global STDIO entry and configures Codex to forward the current terminal's port with a 75-second tool timeout. The low-level CLI command alone cannot persist those two additional settings; its manual equivalent starts with:

```powershell
codex mcp add lumine -- node "$env:USERPROFILE\.lumine\packages\lumine-mcp\lib\server.js"
```

Then add these fields under `[mcp_servers.lumine]` in `~/.codex/config.toml`:

```toml
env_vars = ["LUMINE_BRIDGE_PORT"]
tool_timeout_sec = 75
```

### JSON config

A JSON config expands nothing, so the path has to be absolute and, on Windows, backslash-escaped:

```json
{
  "mcpServers": {
    "lumine": {
      "command": "node",
      "args": ["/home/you/.lumine/packages/lumine-mcp/lib/server.js"]
    }
  }
}
```

```json
{
  "mcpServers": {
    "lumine": {
      "command": "node",
      "args": ["C:\\Users\\you\\.lumine\\packages\\lumine-mcp\\lib\\server.js"]
    }
  }
}
```

### Supplying the current window's port

An agent launched from the `terminal` or `terminal-spawn` package inherits `LUMINE_BRIDGE_PORT` from that window. `ConnectToLumine` can then omit its argument, but it still asks for approval. The variable is only a locator: it carries no credential and never bypasses the approval prompt. For a client launched elsewhere, tell the agent which port to pass to `ConnectToLumine`.

### Talking to the bridge directly

The bridge is HTTP, and anything that speaks MCP over streamable HTTP can use it without the shim. The client first posts `{ "clientName": "…" }` to `/authorize` and waits for the user to approve the request in that window; the response supplies the bearer token for the bridge's other routes. Any request carrying an `Origin` header is refused outright: a browser is never a legitimate caller, and the loopback interface is reachable from every page the user visits. `GET /health` and `POST /authorize` are the only routes that answer without a token.

## Services

- [`mcp.bridge`](docs/mcp.bridge.md): provided to other packages to read the MCP bridge state and await the port assigned during startup.
- [`mcp.tools`](docs/mcp.tools.md): consumed to let other packages register additional MCP tools; each tool defines a name, description, input schema, and execute function.

Consuming the `mcp.bridge` service, in your `package.json`:

```json
{
  "consumedServices": {
    "mcp.bridge": {
      "versions": {
        "^1.1.0": "consumeLumineMcp"
      }
    }
  }
}
```

In your main module:

```javascript
consumeLumineMcp(service) {
  // Get current bridge port
  const port = service.getBridgePort();

  // Or wait for an in-flight automatic start
  service.getBridgePortWhenReady().then((readyPort) => {
    // Use the port for a process launched after the bridge is ready
  });

  // Check if bridge is running
  const running = service.isRunning();

  // Get path to MCP server script
  const serverPath = service.getServerPath();
}
```

Providing extra tools via the `mcp.tools` service, in your `package.json`:

```json
{
  "providedServices": {
    "mcp.tools": {
      "versions": {
        "1.0.0": "provideMcpTools"
      }
    }
  }
}
```

In your main module:

```javascript
module.exports = {
  provideMcpTools() {
    return [
      {
        name: "MyCustomTool",
        description: "Description for the AI",
        inputSchema: {
          type: "object",
          properties: {
            param: { type: "string", description: "Parameter description" },
          },
          required: ["param"],
        },
        annotations: { readOnlyHint: true },
        execute({ param }) {
          // Tool implementation
          return { result: "data" };
        },
      },
    ];
  },
};
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
