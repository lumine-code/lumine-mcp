# mcp.tools

Publishes tools to a connected MCP host, so an assistant can query or act on what a package knows.

|             |                                                           |
| ----------- | --------------------------------------------------------- |
| Version     | `1.0.0`                                                   |
| Provided by | `provideMcpTools()` returning an array of tools           |
| Consumed by | `consumeMcpTools(tools)` returning a `Disposable`         |
| Owner       | [`lumine-mcp`](https://github.com/lumine-code/lumine-mcp) |

`linter` provides this today, exposing its diagnostics as a read-only tool. Any package holding state an assistant would benefit from — a build's output, a project index, a test run — can do the same.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "mcp.tools": {
      "versions": { "1.0.0": "provideMcpTools" }
    }
  }
}
```

**Return an array**, even for a single tool. A non-array is rejected outright with a logged error and nothing is registered.

## Contract

```ts
type Tool = {
  name: string;
  execute(args: object): unknown | Promise<unknown>;
  description?: string;
  inputSchema?: object;
};
```

| Field           | Description                                                                      |
| --------------- | -------------------------------------------------------------------------------- |
| `name`          | Required. The tool name the host calls, and the key it is registered under.      |
| `execute(args)` | Required. Runs the tool and returns its result. May be async.                    |
| `description`   | What the tool does, for the host to show the model. Defaults to an empty string. |
| `inputSchema`   | A JSON Schema for `args`, so the host can validate and describe the call.        |

## Minimal example

```js
module.exports = {
  provideMcpTools() {
    return [
      {
        name: "GetBuildStatus",
        description: "Returns the status of the most recent build.",
        inputSchema: {
          type: "object",
          properties: { target: { type: "string" } },
        },
        execute: ({ target }) => this.statusFor(target),
      },
    ];
  },
};
```

## Behavior

**Tools missing `name` or `execute` are skipped individually**, with an error logged, and the rest of the array still registers. A malformed tool therefore fails silently from the user's point of view — check the console when a tool does not appear.

Names are a **flat global namespace** shared with every other package's tools and with `lumine-mcp`'s built-ins. Registering a name already taken replaces the previous tool, so prefix distinctively; `GetLinterMessages` rather than `Get`.

Prefer read-only tools, and design a mutating one to be idempotent and narrowly scoped — the caller is a model, and it may retry.

Give a real `description` and an `inputSchema`. They are the only things the host has to decide whether and how to call your tool; a tool without them is effectively invisible.

`execute` may return anything serialisable. Return structured data rather than pre-formatted prose.

## Teardown

`consumeMcpTools` returns a `Disposable` that unregisters exactly the tools that were accepted from your array. You need not track them yourself.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
