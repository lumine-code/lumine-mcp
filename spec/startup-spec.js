const path = require("node:path");
const { spawnSync } = require("node:child_process");

describe("MCP tool registration at startup", () => {
  it("registers and revokes tools without loading the HTTP bridge", () => {
    const root = path.dirname(__dirname);
    const eventKit = require.resolve("@lumine-code/event-kit", {
      paths: [lumine.application.getResourcePath()],
    });
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `const assert = require('node:assert/strict');
        const Module = require('node:module');
        const api = require(${JSON.stringify(eventKit)});
        const originalLoad = Module._load;
        Module._load = function(request, ...args) {
          return request === 'lumine' ? api : originalLoad.call(this, request, ...args);
        };
        global.lumine = {
          config: { get: () => false, onDidChange: () => new api.Disposable() },
          commands: { add: () => new api.Disposable() },
        };
        const main = require(${JSON.stringify(path.join(root, "lib/main.js"))});
        const registry = require(${JSON.stringify(path.join(root, "lib/external-tools.js"))});
        const bridge = ${JSON.stringify(path.join(root, "lib/bridge.js"))};
        main.activate();
        const tool = { name: 'StartupSpec', execute: () => 42 };
        const lease = main.consumeMcpTools([tool]);
        assert.equal(registry.getExternalTools().get(tool.name), tool);
        assert.equal(require.cache[bridge], undefined);
        lease.dispose();
        assert.equal(registry.getExternalTools().has(tool.name), false);
        assert.equal(require.cache[bridge], undefined);
        main.consumeMcpTools([tool]);
        (async () => {
          const server = await require(bridge).startBridge({ port: 0 });
          try {
            const list = async () => {
              const response = await fetch('http://127.0.0.1:' + server.port + '/tools', {
                headers: { Authorization: 'Bearer ' + server.token },
              });
              assert.equal(response.status, 200);
              return (await response.json()).tools.map(tool => tool.name);
            };
            assert((await list()).includes(tool.name));
            await main.deactivate();
            assert.equal(registry.getExternalTools().has(tool.name), false);
            assert(!(await list()).includes(tool.name));
          } finally { await server.stop(); }
        })().catch(error => { console.error(error); process.exitCode = 1; });`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: 20000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status)
      .withContext(result.stderr || result.stdout)
      .toBe(0);
  });
});
