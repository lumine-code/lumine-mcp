# mcp.bridge

Reports the MCP bridge's state, waits for automatic startup, and locates its server script.

|             |                                                           |
| ----------- | --------------------------------------------------------- |
| Version     | `1.1.0` (`1.0.0` remains available)                       |
| Provided by | `provideMcpBridge()` returning the state facade           |
| Consumed by | `consumeMcpBridge(bridge)`                                |
| Owner       | [`lumine-mcp`](https://github.com/lumine-code/lumine-mcp) |

The `terminal` and `terminal-spawn` packages consume this service to give newly launched shells the port of their own Lumine window. The service never exposes the bridge token: every client must still request approval through `ConnectToLumine`. To _publish_ a tool through the bridge, provide [`mcp.tools`](mcp.tools.md) instead.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "mcp.bridge": {
      "versions": { "^1.1.0": "consumeMcpBridge" }
    }
  }
}
```

## Contract

```ts
type McpBridge = {
  getBridgePort(): number | null;
  getBridgePortWhenReady(): Promise<number | null>;
  isRunning(): boolean;
  getServerPath(): string;
};
```

| Member                     | Description                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `getBridgePort()`          | The port the bridge is listening on, or `null` when it is not running.                             |
| `getBridgePortWhenReady()` | Wait for an in-progress automatic or manual start, then return the port; return `null` on failure. |
| `isRunning()`              | Whether the bridge is up.                                                                          |
| `getServerPath()`          | Absolute path to the MCP server script, for configuring an external host.                          |

## Minimal example

```js
const { Disposable } = require("lumine");

module.exports = {
  consumeMcpBridge(bridge) {
    this.bridge = bridge;
    this.render();
    return new Disposable(() => {
      this.bridge = null;
      this.render();
    });
  },

  async render() {
    const port = await this.bridge?.getBridgePortWhenReady();
    this.tile.textContent = port ? `MCP :${port}` : "MCP off";
  },
};
```

## Behavior

**There is no change notification.** The synchronous members are polled, so a consumer displaying the state has to decide when to re-read it — on a command, on the settings panel opening, or on its own timer. Do not assume a value stays valid.

`getBridgePortWhenReady()` coalesces with the package's current startup attempt. It returns `null` immediately when no start is in progress and the bridge is stopped, and returns `null` after a failed start. It does not start the bridge itself.

`getBridgePort()` returning `null` and `isRunning()` returning `false` are the same condition; the port is the more useful of the two because it is what a terminal passes to a client. Knowing the port grants no access by itself.

`getServerPath()` is resolved from the package's own installation and remains available for low-level integrations. User-facing Claude Code and Codex setup should use the package's registration commands, which also apply the client-specific global settings safely.

Receiving the service means `lumine-mcp` is installed and active, not that the bridge is up.

## Teardown

Return a `Disposable` that drops your reference and clears whatever you rendered. The bridge holds nothing on your behalf.

## Versioning

`1.0.0` and `1.1.0` are provided. Version `1.1.0` adds `getBridgePortWhenReady()` without removing the `1.0.0` members. Consumers that need startup coordination request `^1.1.0`; older `^1.0.0` consumers remain compatible.
