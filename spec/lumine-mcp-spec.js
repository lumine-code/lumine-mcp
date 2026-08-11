const fs = require("fs");
const os = require("os");
const path = require("path");
const { startBridge, stopBridge, setExternalTools, openStreamCount } = require("../lib/bridge");
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

    describe("the protocol lifecycle", () => {
      const initialize = (protocolVersion) => ({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion, clientInfo: { name: "spec" } },
      });

      const openSession = async () => {
        const response = await post("/mcp", initialize("2025-11-25"));
        return response.headers.get("mcp-session-id");
      };

      // Answering in our own version whatever was asked told a client on an
      // older one that we had agreed to its request when we had not.
      it("answers initialize in the version the client asked for", async () => {
        const answer = await (await post("/mcp", initialize("2025-06-18"))).json();
        expect(answer.result.protocolVersion).toBe("2025-06-18");
      });

      it("answers in its own version when the client's is unknown", async () => {
        const answer = await (await post("/mcp", initialize("1.0.0"))).json();
        expect(answer.result.protocolVersion).toBe("2025-11-25");
      });

      it("declares that its tool list changes", async () => {
        const answer = await (await post("/mcp", initialize("2025-11-25"))).json();
        expect(answer.result.capabilities.tools.listChanged).toBe(true);
      });

      it("refuses a request that names no session", async () => {
        const response = await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
        expect(response.status).toBe(400);
      });

      it("refuses a request naming a session it does not know", async () => {
        const response = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            ...auth,
            "Content-Type": "application/json",
            "Mcp-Session-Id": "00000000-0000-0000-0000-000000000000",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        });
        // 404 is what tells a client to start over rather than to give up.
        expect(response.status).toBe(404);
      });

      // Both are what a client has before it can hold a session, and a
      // notification cannot be answered at all, so refusing one is only silent.
      it("lets initialize, ping and notifications through without one", async () => {
        expect((await post("/mcp", initialize("2025-11-25"))).status).toBe(200);
        expect((await post("/mcp", { jsonrpc: "2.0", id: 2, method: "ping" })).status).toBe(200);
        expect(
          (await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" })).status,
        ).toBe(202);
      });

      it("forgets a session that is terminated, and says so afterwards", async () => {
        const session = await openSession();
        const headers = { ...auth, "Mcp-Session-Id": session };
        expect((await fetch(`${base}/mcp`, { method: "DELETE", headers })).status).toBe(204);

        const response = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
        });
        expect(response.status).toBe(404);
      });

      it("hands a batch back the session its initialize opened", async () => {
        const response = await post("/mcp", [
          initialize("2025-11-25"),
          { jsonrpc: "2.0", id: 2, method: "ping" },
        ]);
        expect(response.headers.get("mcp-session-id")).toBeTruthy();
      });

      it("refuses an MCP-Protocol-Version it does not speak", async () => {
        const response = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            ...auth,
            "Content-Type": "application/json",
            "MCP-Protocol-Version": "2024-01-01",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
        });
        expect(response.status).toBe(400);
      });

      describe("the server's own channel to the client", () => {
        let session, request, frames;

        const text = () => frames.join("");

        beforeEach(async () => {
          session = await openSession();
          frames = [];
          await new Promise((resolve, reject) => {
            request = require("http").request(
              {
                host: "127.0.0.1",
                port: bridge.port,
                path: "/mcp",
                method: "GET",
                headers: { ...auth, Accept: "text/event-stream", "Mcp-Session-Id": session },
              },
              (response) => {
                response.setEncoding("utf8");
                response.on("data", (chunk) => frames.push(chunk));
                resolve();
              },
            );
            request.on("error", reject);
            request.end();
          });
          // The bridge opens with a comment frame, so the stream is known to
          // be registered before anything is expected to arrive on it.
          await conditionPromise(() => text().includes(": open"));
        });

        afterEach(() => {
          request.destroy();
        });

        it("says when a package registers a tool", async () => {
          setExternalTools(new Map([["SpecTool", { name: "SpecTool", execute: () => null }]]));
          await conditionPromise(() => text().includes("notifications/tools/list_changed"));
        });

        it("says when the user turns a tool off", async () => {
          const original = lumine.config.get("lumine-mcp.toolList");
          lumine.config.set("lumine-mcp.toolList", [...original, "GetActiveEditor"]);
          await conditionPromise(() => text().includes("notifications/tools/list_changed"));
          lumine.config.set("lumine-mcp.toolList", original);
        });

        it("refuses to open one for a session it does not know", async () => {
          const response = await fetch(`${base}/mcp`, {
            headers: { ...auth, Accept: "text/event-stream", "Mcp-Session-Id": "nope" },
          });
          expect(response.status).toBe(404);
        });
      });
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
      let server, lines, pending, httpSession;

      const ask = (message) => {
        const answer = new Promise((resolve) => pending.push(resolve));
        server.stdin.write(JSON.stringify(message) + "\n");
        return answer;
      };

      // The shim's opposite number: the same conversation held directly, so
      // the two can be compared message for message. It keeps its own session
      // for the same reason the shim keeps one.
      const overHttp = async (message) => {
        const headers = { ...auth, "Content-Type": "application/json" };
        if (httpSession) headers["Mcp-Session-Id"] = httpSession;
        const response = await fetch(`${base}/mcp`, {
          method: "POST",
          headers,
          body: JSON.stringify(message),
        });
        const issued = response.headers.get("mcp-session-id");
        if (issued) httpSession = issued;
        return response.status === 202 ? null : response.json();
      };

      const INITIALIZE = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", clientInfo: { name: "spec" } },
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
        httpSession = null;
        server = spawnServer();
      });

      afterEach(async () => {
        server.stdin.end();
        await new Promise((resolve) => server.once("exit", resolve));
      });

      it("answers initialize exactly as the bridge does", async () => {
        expect(await ask(INITIALIZE)).toEqual(await overHttp(INITIALIZE));
      });

      it("answers tools/list exactly as the bridge does", async () => {
        // tools/list belongs to a session now, and each side opens its own.
        await ask(INITIALIZE);
        await overHttp(INITIALIZE);
        const message = { jsonrpc: "2.0", id: 2, method: "tools/list" };
        expect(await ask(message)).toEqual(await overHttp(message));
      });

      // The shim holds the session for the host, which never sees one.
      it("carries the session it was given through to the next request", async () => {
        await ask(INITIALIZE);
        const answer = await ask({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        expect(answer.result.tools.length).toBeGreaterThan(0);
      });

      // Nothing the host sent asked for this: it starts at the bridge.
      it("relays a notification the bridge starts", async () => {
        await ask(INITIALIZE);
        const relayed = new Promise((resolve) => pending.push(resolve));
        // The shim opens its stream once initialize is answered, which is a
        // round trip behind the answer the host already has.
        await conditionPromise(() => openStreamCount() > 0);
        setExternalTools(new Map([["SpecTool", { name: "SpecTool", execute: () => null }]]));
        expect(await relayed).toEqual({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
        });
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
