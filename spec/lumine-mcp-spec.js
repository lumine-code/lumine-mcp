const fs = require("fs");
const os = require("os");
const path = require("path");
const { startBridge, stopBridge, setExternalTools } = require("../lib/bridge");
const endpoint = require("../lib/endpoint");

describe("lumine-mcp", () => {
  let mainModule, registry, originalRegistry;

  beforeEach(async () => {
    // LUMINE_HOME is the developer's real one even under `lumine --test`, so
    // the registry is redirected: a bridge started by a spec must not be
    // something a real MCP client can find.
    originalRegistry = process.env.LUMINE_MCP_REGISTRY;
    registry = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-mcp-registry-"));
    process.env.LUMINE_MCP_REGISTRY = registry;

    // Keep the bridge from grabbing a real port on activation.
    lumine.config.set("lumine-mcp.autoStart", false);
    const activation = lumine.packages.activatePackage("lumine-mcp");
    lumine.packages.triggerDeferredActivationHooks();
    lumine.packages.triggerActivationHook("core:loaded-shell-environment");
    mainModule = (await activation).mainModule;
  });

  afterEach(() => {
    if (originalRegistry === undefined) delete process.env.LUMINE_MCP_REGISTRY;
    else process.env.LUMINE_MCP_REGISTRY = originalRegistry;
    fs.rmSync(registry, { recursive: true, force: true, maxRetries: 3 });
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
    let bridge, base, auth;

    // Every route past /health wants the token, so almost every request in
    // this suite carries it; the ones that deliberately do not say so.
    const get = (route) => fetch(`${base}${route}`, { headers: auth });
    const post = (route, body) =>
      fetch(`${base}${route}`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });

    // `Origin` is a forbidden header name to fetch(), which is running in a
    // renderer here — it will not send one however it is asked. A browser is
    // imitated at the socket instead.
    const raw = (route, headers = {}) =>
      new Promise((resolve, reject) => {
        const request = require("http").request(
          { host: "127.0.0.1", port: bridge.port, path: route, method: "GET", headers },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response));
          },
        );
        request.on("error", reject);
        request.end();
      });

    beforeEach(async () => {
      // Port 0 lets the OS assign a free ephemeral port: no CI collisions.
      bridge = await startBridge({ port: 0 });
      base = `http://127.0.0.1:${bridge.port}`;
      auth = { Authorization: `Bearer ${bridge.token}` };
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

    it("answers the health check without a token", async () => {
      const response = await fetch(`${base}/health`);
      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.status).toBe("ok");
    });

    describe("access control", () => {
      it("refuses a request with no token", async () => {
        const response = await fetch(`${base}/tools`);
        expect(response.status).toBe(401);
      });

      it("refuses a request with the wrong token", async () => {
        const response = await fetch(`${base}/tools`, {
          headers: { Authorization: `Bearer ${"0".repeat(bridge.token.length)}` },
        });
        expect(response.status).toBe(401);
      });

      // A token of a different length must not be distinguishable from a
      // wrong one of the right length, and neither may throw.
      it("refuses a token of the wrong length", async () => {
        const response = await fetch(`${base}/tools`, {
          headers: { Authorization: "Bearer short" },
        });
        expect(response.status).toBe(401);
      });

      // The loopback interface is reachable from every page the user visits,
      // so an Origin header is the tell that this is a browser and not a host.
      it("refuses anything carrying an Origin, token or not", async () => {
        for (const headers of [{ Origin: "https://evil.example" }, { ...auth, Origin: "null" }]) {
          expect((await raw("/health", headers)).statusCode).toBe(403);
        }
      });

      it("offers no CORS headers to a browser that tries anyway", async () => {
        const response = await raw("/health");
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      });
    });

    describe("the endpoint registry", () => {
      it("publishes the port and token while the bridge is up", () => {
        const entries = endpoint.list();
        expect(entries.length).toBe(1);
        expect(entries[0].port).toBe(bridge.port);
        expect(entries[0].token).toBe(bridge.token);
        expect(fs.existsSync(endpoint.endpointPath(bridge.port))).toBe(true);
      });

      it("withdraws the entry when the bridge stops", async () => {
        const port = bridge.port;
        await stopBridge(bridge);
        bridge = null;
        expect(fs.existsSync(endpoint.endpointPath(port))).toBe(false);
        expect(endpoint.list()).toEqual([]);
      });

      it("ignores a file that is not an endpoint", () => {
        fs.writeFileSync(path.join(registry, "notes.txt"), "not mine");
        fs.writeFileSync(path.join(registry, "broken.json"), "{ half writ");
        expect(endpoint.list().length).toBe(1);
      });
    });

    it("lists enabled tools and hides blacklisted ones", async () => {
      const { tools } = await (await get("/tools")).json();
      const names = tools.map((t) => t.name);
      expect(names).toContain("GetActiveEditor");
      expect(names).toContain("GetProjectPaths");
      // CloseFile and RemoveProjectPath are blacklisted by default.
      expect(names).not.toContain("CloseFile");
      expect(names).not.toContain("RemoveProjectPath");
    });

    it("executes a builtin tool over the REST endpoint", async () => {
      const response = await post("/tools/GetProjectPaths", "{}");
      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });

    it("refuses to execute a disabled tool", async () => {
      const response = await post("/tools/CloseFile", "{}");
      expect(response.status).toBe(400);
      const result = await response.json();
      expect(result.success).toBe(false);
      expect(result.error).toContain("disabled");
    });

    it("speaks the MCP JSON-RPC protocol", async () => {
      const initResponse = await post("/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", clientInfo: { name: "spec" } },
      });
      const session = initResponse.headers.get("mcp-session-id");
      expect(session).toBeTruthy();
      const init = await initResponse.json();
      expect(init.result.serverInfo.name).toBe("lumine-mcp");
      expect(init.result.protocolVersion).toBe("2025-11-25");

      const callResponse = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json", "Mcp-Session-Id": session },
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

      let { tools } = await (await get("/tools")).json();
      expect(tools.map((t) => t.name)).toContain("SpecTool");

      const result = await (await post("/tools/SpecTool", "{}")).json();
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ hello: "lumine" });

      disposable.dispose();
      ({ tools } = await (await get("/tools")).json());
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
        const response = await post("/mcp", message);
        return response.status === 202 ? null : response.json();
      };

      // The port pins the shim to this bridge; the token is deliberately not
      // passed, so every run exercises the registry lookup that finds it.
      const spawnServer = (env = {}) => {
        const child = require("child_process").spawn(
          process.execPath,
          [path.join(__dirname, "..", "lib", "server.js")],
          {
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: "1",
              LUMINE_BRIDGE_HOST: "127.0.0.1",
              LUMINE_BRIDGE_PORT: String(bridge.port),
              ...env,
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        require("readline")
          .createInterface({ input: child.stdout })
          .on("line", (line) => {
            lines.push(JSON.parse(line));
            pending.shift()?.(lines[lines.length - 1]);
          });
        return child;
      };

      beforeEach(() => {
        jasmine.useRealClock();
        lines = [];
        pending = [];
        server = spawnServer();
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

      // No port, no token: it has only the registry to go on.
      describe("finding the editor on its own", () => {
        beforeEach(async () => {
          server.stdin.end();
          await new Promise((resolve) => server.once("exit", resolve));
          lines = [];
          pending = [];
          server = spawnServer({ LUMINE_BRIDGE_PORT: "" });
        });

        it("discovers the running bridge through the registry", async () => {
          const answer = await ask({ jsonrpc: "2.0", id: 7, method: "ping" });
          expect(answer).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
        });
      });

      describe("with no bridge to find", () => {
        let empty;

        beforeEach(async () => {
          server.stdin.end();
          await new Promise((resolve) => server.once("exit", resolve));
          lines = [];
          pending = [];
          empty = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-mcp-empty-"));
          server = spawnServer({ LUMINE_BRIDGE_PORT: "", LUMINE_MCP_REGISTRY: empty });
        });

        afterEach(() => {
          fs.rmSync(empty, { recursive: true, force: true, maxRetries: 3 });
        });

        it("says so rather than leaving the host waiting", async () => {
          const answer = await ask({ jsonrpc: "2.0", id: 8, method: "ping" });
          expect(answer.error.code).toBe(-32603);
          expect(answer.error.message).toContain("No Lumine bridge is running");
        });
      });
    });
  });
});
