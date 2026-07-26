# mcp.bridge

Reports the MCP bridge's state: whether it is running, on which port, and where its server script lives.

|             |                                                           |
| ----------- | --------------------------------------------------------- |
| Version     | `1.0.0`                                                   |
| Provided by | `provideMcpBridge()` returning the state facade           |
| Consumed by | `consumeMcpBridge(bridge)`                                |
| Owner       | [`lumine-mcp`](https://github.com/lumine-code/lumine-mcp) |

**No package consumes this today.** It exists so a status indicator, a settings view, or a tool that needs to point an external host at the bridge can find it. To _publish_ a tool through the bridge, provide [`mcp.tools`](mcp.tools.md) instead.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "mcp.bridge": {
      "versions": { "^1.0.0": "consumeMcpBridge" }
    }
  }
}
```

## Contract

```ts
type McpBridge = {
  getBridgePort(): number | null;
  isRunning(): boolean;
  getServerPath(): string;
};
```

| Member            | Description                                                               |
| ----------------- | ------------------------------------------------------------------------- |
| `getBridgePort()` | The port the bridge is listening on, or `null` when it is not running.    |
| `isRunning()`     | Whether the bridge is up.                                                 |
| `getServerPath()` | Absolute path to the MCP server script, for configuring an external host. |

## Minimal example

```js
const { Disposable } = require("atom");

module.exports = {
  consumeMcpBridge(bridge) {
    this.bridge = bridge;
    this.render();
    return new Disposable(() => {
      this.bridge = null;
      this.render();
    });
  },

  render() {
    const port = this.bridge?.getBridgePort();
    this.tile.textContent = port ? `MCP :${port}` : "MCP off";
  },
};
```

## Behavior

**There is no change notification.** All three members are polled, so a consumer displaying the state has to decide when to re-read it — on a command, on the settings panel opening, or on its own timer. Do not assume a value stays valid.

`getBridgePort()` returning `null` and `isRunning()` returning `false` are the same condition; the port is the more useful of the two because it is what an external host needs.

`getServerPath()` is resolved from the package's own installation and is valid whether or not the bridge is running — it is the path you put in an external MCP host's configuration.

Receiving the service means `lumine-mcp` is installed and active, not that the bridge is up.

## Teardown

Return a `Disposable` that drops your reference and clears whatever you rendered. The bridge holds nothing on your behalf.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
