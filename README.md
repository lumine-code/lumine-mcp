# lumine-mcp

Model Context Protocol server exposing editor tools to AI assistants.

## Features

- **MCP protocol**: version 2025-11-25 with tool annotations support.
- **HTTP bridge**: server running inside Lumine for direct API access.
- **Standalone server**: stdio script for Claude CLI, answering out of the same endpoint the bridge serves over HTTP.
- **Editor tools**: get/set content, open/save files, manage selections.
- **Extensible**: other packages can register tools via `mcp.tools` service.
- **Toggle tools**: enable/disable individual tools via select list. Destructive tools disabled by default.

## Installation

To install `lumine-mcp` search for _lumine-mcp_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/lumine-mcp`.

## Commands

Commands available in `lumine-workspace`:

- `lumine-mcp:toggle-tools`: toggle individual tools on/off,
- `lumine-mcp:start`: start the MCP bridge server,
- `lumine-mcp:stop`: stop the MCP bridge server,
- `lumine-mcp:status`: show current bridge status and port.

Commands available in `.lumine-mcp`:

- `lumine-mcp:toggle-mode`: switch blacklist/greenlist mode,
- `lumine-mcp:enable-all`: enable all tools,
- `lumine-mcp:disable-all`: disable all tools,
- `lumine-mcp:reset-defaults`: reset to defaults.

## Built-in Tools

| Tool                | Description                                                                                     | Default  |
| ------------------- | ----------------------------------------------------------------------------------------------- | -------- |
| `GetActiveEditor`   | Get editor metadata (path, grammar, modified, lineCount)                                        | Enabled  |
| `GetOpenEditors`    | Get metadata for all open text editors                                                          | Enabled  |
| `ReadText`          | Read active editor content with line pagination (use agent's file tools for other files)        | Enabled  |
| `WriteText`         | Write text at cursor or replace range in active editor (use agent's file tools for other files) | Enabled  |
| `OpenFile`          | Open an existing file in editor with optional position (`create=true` allows new files)         | Enabled  |
| `SaveFile`          | Save a file (active editor or specific path)                                                    | Enabled  |
| `GetSelections`     | Get all selections/cursors with positions and text from active editor                           | Enabled  |
| `SetSelections`     | Set multiple selections/cursors at specific positions in active editor                          | Enabled  |
| `CloseFile`         | Close an editor tab                                                                             | Disabled |
| `GetProjectPaths`   | Get project root folders                                                                        | Enabled  |
| `AddProjectPath`    | Add a folder to project roots                                                                   | Enabled  |
| `RemoveProjectPath` | Remove a folder from project roots                                                              | Disabled |

## MCP Client Integration

The standalone MCP server (`lib/server.js`) works with any MCP host that can spawn a command.

**It finds the editor on its own.** Every running bridge publishes its port and a token minted for that run under `~/.lumine/mcp/`, and the server reads that registry on its first message and again after any failure. A host configured once keeps working across editor restarts, across bridges that land on a different port, and with several windows open. Nothing needs configuring when the port changes.

### Claude Code

Register the server with the Claude CLI, from the directory the package is installed in:

```bash
claude mcp add lumine -- node ~/.lumine/packages/lumine-mcp/lib/server.js
```

On Windows, in PowerShell:

```bash
claude mcp add lumine -- node "$env:USERPROFILE\.lumine\packages\lumine-mcp\lib\server.js"
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

### Pointing at one particular window

With several windows open, the server takes the most recently started bridge that still answers. To pin it to one, set `LUMINE_BRIDGE_PORT` — the port `Lumine MCP: Status` reports for that window — and the registry supplies the token:

```json
{
  "mcpServers": {
    "lumine": {
      "command": "node",
      "args": ["/home/you/.lumine/packages/lumine-mcp/lib/server.js"],
      "env": { "LUMINE_BRIDGE_PORT": "3001" }
    }
  }
}
```

### Talking to the bridge directly

The bridge is HTTP, and anything that speaks MCP over streamable HTTP can use it without this shim — but it is not an open port. Requests must present the token from `~/.lumine/mcp/<port>.json` as `Authorization: Bearer <token>`, and any request carrying an `Origin` header is refused outright: a browser is never a legitimate caller, and the loopback interface is reachable from every page the user visits. `GET /health` is the only route that answers without the token, so a client can confirm a published endpoint before trusting it.

## Services

- **[mcp.bridge](docs/mcp.bridge.md)** (`1.0.0`): provided to other packages to read the MCP bridge state: port, running status, and server script path.
- **[mcp.tools](docs/mcp.tools.md)** (`^1.0.0`): consumed to let other packages register additional MCP tools; each tool defines a name, description, input schema, and execute function.

Consuming the `mcp.bridge` service, in your `package.json`:

```json
{
  "consumedServices": {
    "mcp.bridge": {
      "versions": {
        "^1.0.0": "consumeLumineMcp"
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
