const path = require("path");
const { startBridge, stopBridge, setExternalTools } = require("../lib/bridge");

describe("lumine-mcp", () => {
  let mainModule;

  beforeEach(async () => {
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
  });
});
