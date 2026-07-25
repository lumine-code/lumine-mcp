# lumine-mcp

Model Context Protocol server, that provides Lumine editor tools to AI assistants.

## Features

- **MCP protocol**: version 2025-11-25 with tool annotations support.
- **HTTP bridge**: server running inside Lumine for direct API access.
- **Standalone server**: MCP server script for Claude CLI integration.
- **Editor tools**: get/set content, open/save files, manage selections.
- **Extensible**: other packages can register tools via `mcp-tools` service.
- **Toggle tools**: enable/disable individual tools via select list. Destructive tools disabled by default.

## Installation

To install `lumine-mcp` search for _lumine-mcp_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/lumine-mcp`.

## Commands

Commands available in `atom-workspace`:

- `lumine-mcp:toggle-tools`: toggle individual tools on/off,
- `lumine-mcp:start`: start the MCP bridge server,
- `lumine-mcp:stop`: stop the MCP bridge server,
- `lumine-mcp:status`: show current bridge status and port.

Commands available in `.lumine-mcp`:

- `select-list:toggle-mode`: switch blacklist/greenlist mode,
- `select-list:enable-all`: enable all tools,
- `select-list:disable-all`: disable all tools,
- `select-list:reset-defaults`: reset to defaults.

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

The standalone MCP server (`lib/server.js`) can be used with any MCP-compatible client. The server connects to the Lumine bridge via `LUMINE_BRIDGE_PORT` (default `3000`). Check the actual port with `lumine-mcp:status`. It auto-increments when multiple Lumine windows are open.

### Claude Code

Register the server with the Claude CLI:

```bash
claude mcp add -e LUMINE_BRIDGE_PORT=3000 lumine -- node ~/.lumine/packages/lumine-mcp/lib/server.js
```

On Windows:

```bash
claude mcp add -e LUMINE_BRIDGE_PORT=3000 lumine -- node "%USERPROFILE%\.lumine\packages\lumine-mcp\lib\server.js"
```

### JSON config

```json
{
  "mcpServers": {
    "lumine": {
      "command": "node",
      "args": ["~/.lumine/packages/lumine-mcp/lib/server.js"],
      "env": {
        "LUMINE_BRIDGE_PORT": "3000"
      }
    }
  }
}
```

On Windows, use `"%USERPROFILE%\.lumine\packages\lumine-mcp\lib\server.js"`.

## Services

- **lumine-mcp** (`1.0.0`): provided to other packages to read the MCP bridge state: port, running status, and server script path.
- **mcp-tools** (`^1.0.0`): consumed to let other packages register additional MCP tools; each tool defines a name, description, input schema, and execute function.

Consuming the `lumine-mcp` service, in your `package.json`:

```json
{
  "consumedServices": {
    "lumine-mcp": {
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

Providing extra tools via the `mcp-tools` service, in your `package.json`:

```json
{
  "providedServices": {
    "mcp-tools": {
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
