const path = require("path");
const { startBridge, stopBridge, setExternalTools } = require("../lib/bridge");

describe("lumine-mcp", () => {
  let mainModule, modals;

  beforeEach(async () => {
    // The shared modal vocabulary lives in the editor checkout, which sits at a
    // different depth relative to this package in the workspace than it does in
    // CI, so resolve it through the running editor instead.
    modals = require(
      path.join(atom.getLoadSettings().resourcePath, "spec", "helpers", "modal-helpers"),
    );

    // Keep the bridge from grabbing a real port on activation.
    atom.config.set("lumine-mcp.autoStart", false);
    const activation = atom.packages.activatePackage("lumine-mcp");
    atom.packages.triggerDeferredActivationHooks();
    atom.packages.triggerActivationHook("core:loaded-shell-environment");
    mainModule = (await activation).mainModule;
  });

  describe("lumine-mcp service", () => {
    it("exposes the bridge state accessors", () => {
      const service = mainModule.provideMcpBridge();
      expect(typeof service.getBridgePort).toBe("function");
      expect(typeof service.isRunning).toBe("function");
      expect(typeof service.getServerPath).toBe("function");

      expect(service.isRunning()).toBe(false);
      expect(service.getBridgePort()).toBeNull();
      expect(path.basename(service.getServerPath())).toBe("server.js");
    });
  });

  // The tool list runs on the core modal kernel, so it is asserted through the
  // editor's own modal spec vocabulary rather than this view's internals.
  describe("the tool list", () => {
    const session = () => modals.activeSession();
    const dispatch = (command) => modals.dispatch(command);
    const labels = () => modals.visibleLabels();

    // Every verb writes config synchronously and then asks the kernel to re-run
    // the source; this drains that hop.
    const settle = () => modals.settle();

    const toggleCommand = () =>
      atom.commands.dispatch(atom.workspace.getElement(), "lumine-mcp:toggle-tools");

    const open = async () => {
      toggleCommand();
      await settle();
    };

    beforeEach(() => {
      atom.config.set("lumine-mcp.listMode", "blacklist");
      atom.config.set("lumine-mcp.toolList", ["CloseFile", "RemoveProjectPath"]);
    });

    afterEach(() => {
      if (modals.isModalOpen()) atom.modals.cancel("spec");
    });

    it("lists every tool, and toggles closed again", async () => {
      await open();
      expect(labels()).toContain("GetActiveEditor");
      expect(labels()).toContain("CloseFile");

      toggleCommand();
      expect(modals.isModalOpen()).toBe(false);
    });

    it("toggles the focused tool in the list without closing", async () => {
      await open();
      const name = session().getVisibleItems()[0].name;
      expect(session().getFocusedItem().enabled).toBe(true);

      dispatch("core:confirm");
      await settle();

      expect(atom.config.get("lumine-mcp.toolList")).toContain(name);
      expect(modals.isModalOpen()).toBe(true);
      // The row is re-read from config and the focus stays on it, which is what
      // makes toggling several tools in one visit possible.
      expect(session().getFocusedItem().name).toBe(name);
      expect(session().getFocusedItem().enabled).toBe(false);
    });

    it("switches between blacklist and greenlist mode", async () => {
      await open();
      dispatch("modals:toggle-mode");
      await settle();

      expect(atom.config.get("lumine-mcp.listMode")).toBe("greenlist");
      expect(modals.isModalOpen()).toBe(true);
    });

    it("fills or clears the list, whichever the mode means by 'all'", async () => {
      await open();
      const every = session()
        .getItems()
        .map((tool) => tool.name);

      dispatch("modals:disable-all");
      await settle();
      expect(atom.config.get("lumine-mcp.toolList")).toEqual(every);

      dispatch("modals:enable-all");
      await settle();
      expect(atom.config.get("lumine-mcp.toolList")).toEqual([]);

      dispatch("modals:toggle-mode");
      await settle();
      dispatch("modals:enable-all");
      await settle();
      expect(atom.config.get("lumine-mcp.toolList")).toEqual(every);
    });

    it("resets both settings to their schema defaults", async () => {
      atom.config.set("lumine-mcp.listMode", "greenlist");
      atom.config.set("lumine-mcp.toolList", []);
      await open();

      dispatch("modals:reset-defaults");
      await settle();

      expect(atom.config.get("lumine-mcp.listMode")).toBe("blacklist");
      expect(atom.config.get("lumine-mcp.toolList")).toEqual(["CloseFile", "RemoveProjectPath"]);
    });

    // These four used to be `select-list:*` entries in keymaps/lumine-mcp.json.
    it("binds its verbs on the modal's own scope", async () => {
      await open();
      const bound = new Map(
        atom.keymaps
          .findKeyBindings({ target: session().element })
          .map((binding) => [binding.command, binding.keystrokes]),
      );
      expect(bound.get("modals:toggle-mode")).toBe("alt-enter");
      expect(bound.get("modals:enable-all")).toBe("alt-=");
      expect(bound.get("modals:disable-all")).toBe("alt--");
      expect(bound.get("modals:reset-defaults")).toBe("alt-0");
    });
  });

  describe("bridge server", () => {
    let bridge, base;

    beforeEach(async () => {
      // Port 0 lets the OS assign a free ephemeral port: no CI collisions.
      bridge = await startBridge({ port: 0 });
      base = `http://127.0.0.1:${bridge.port}`;
    });

    afterEach(async () => {
      setExternalTools(new Map());
      if (bridge) {
        await stopBridge(bridge);
        bridge = null;
      }
    });

    it("reports the actually bound port", () => {
      expect(bridge.port).toBeGreaterThan(0);
    });

    it("answers the health check", async () => {
      const response = await fetch(`${base}/health`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.status).toBe("ok");
    });

    it("lists enabled tools and hides blacklisted ones", async () => {
      const response = await fetch(`${base}/tools`);
      const { tools } = await response.json();
      const names = tools.map((t) => t.name);
      expect(names).toContain("GetActiveEditor");
      expect(names).toContain("GetProjectPaths");
      // CloseFile and RemoveProjectPath are blacklisted by default.
      expect(names).not.toContain("CloseFile");
      expect(names).not.toContain("RemoveProjectPath");
    });

    it("executes a builtin tool over the REST endpoint", async () => {
      const response = await fetch(`${base}/tools/GetProjectPaths`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });

    it("refuses to execute a disabled tool", async () => {
      const response = await fetch(`${base}/tools/CloseFile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(400);
      const result = await response.json();
      expect(result.success).toBe(false);
      expect(result.error).toContain("disabled");
    });

    it("speaks the MCP JSON-RPC protocol", async () => {
      const initResponse = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", clientInfo: { name: "spec" } },
        }),
      });
      expect(initResponse.headers.get("mcp-session-id")).toBeTruthy();
      const init = await initResponse.json();
      expect(init.result.serverInfo.name).toBe("lumine-mcp");
      expect(init.result.protocolVersion).toBe("2025-11-25");

      const callResponse = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "GetProjectPaths", arguments: {} },
        }),
      });
      const call = await callResponse.json();
      expect(call.result.isError).toBe(false);
      expect(Array.isArray(JSON.parse(call.result.content[0].text))).toBe(true);
    });

    it("registers and unregisters external tools", async () => {
      const disposable = mainModule.consumeMcpTools([
        {
          name: "SpecTool",
          description: "A spec-only tool",
          inputSchema: { type: "object", properties: {}, required: [] },
          annotations: { readOnlyHint: true },
          execute: () => ({ hello: "lumine" }),
        },
      ]);

      let { tools } = await (await fetch(`${base}/tools`)).json();
      expect(tools.map((t) => t.name)).toContain("SpecTool");

      const result = await (
        await fetch(`${base}/tools/SpecTool`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).json();
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ hello: "lumine" });

      disposable.dispose();
      ({ tools } = await (await fetch(`${base}/tools`)).json());
      expect(tools.map((t) => t.name)).not.toContain("SpecTool");
    });

    // The stdio shim used to answer `initialize` and `tools/list` out of its
    // own copy of the protocol, which drifted from the bridge's. It forwards
    // now, and these hold it to that: whatever the bridge says, it says.
    describe("the stdio server", () => {
      let server, lines, pending;

      const ask = (message) => {
        const answer = new Promise((resolve) => pending.push(resolve));
        server.stdin.write(JSON.stringify(message) + "\n");
        return answer;
      };

      const overHttp = async (message) => {
        const response = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message),
        });
        return response.status === 202 ? null : response.json();
      };

      beforeEach(() => {
        jasmine.useRealClock();
        lines = [];
        pending = [];
        server = require("child_process").spawn(
          process.execPath,
          [path.join(__dirname, "..", "lib", "server.js")],
          {
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: "1",
              LUMINE_BRIDGE_HOST: "127.0.0.1",
              LUMINE_BRIDGE_PORT: String(bridge.port),
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        require("readline")
          .createInterface({ input: server.stdout })
          .on("line", (line) => {
            lines.push(JSON.parse(line));
            pending.shift()?.(lines[lines.length - 1]);
          });
      });

      afterEach(async () => {
        server.stdin.end();
        await new Promise((resolve) => server.once("exit", resolve));
      });

      it("answers initialize exactly as the bridge does", async () => {
        const message = {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", clientInfo: { name: "spec" } },
        };
        expect(await ask(message)).toEqual(await overHttp(message));
      });

      it("answers tools/list exactly as the bridge does", async () => {
        const message = { jsonrpc: "2.0", id: 2, method: "tools/list" };
        expect(await ask(message)).toEqual(await overHttp(message));
      });

      // Neither of these reached the old shim's own switch statement.
      it("answers ping, which it never used to implement", async () => {
        const answer = await ask({ jsonrpc: "2.0", id: 3, method: "ping" });
        expect(answer).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
      });

      it("answers every message of a batch", async () => {
        const answer = await ask([
          { jsonrpc: "2.0", id: 4, method: "ping" },
          { jsonrpc: "2.0", id: 5, method: "ping" },
        ]);
        expect(answer).toEqual([
          { jsonrpc: "2.0", id: 4, result: {} },
          { jsonrpc: "2.0", id: 5, result: {} },
        ]);
      });

      it("says nothing back to a notification", async () => {
        server.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
        );
        expect(await ask({ jsonrpc: "2.0", id: 6, method: "ping" })).toEqual({
          jsonrpc: "2.0",
          id: 6,
          result: {},
        });
        expect(lines.length).toBe(1);
      });

      it("reports a malformed line without asking the bridge", async () => {
        const answer = new Promise((resolve) => pending.push(resolve));
        server.stdin.write("not json\n");
        expect((await answer).error.code).toBe(-32700);
      });
    });
  });
});
