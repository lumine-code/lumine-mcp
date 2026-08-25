const fs = require("fs");
const os = require("os");
const path = require("path");
const { startBridge, stopBridge, setExternalTools, openStreamCount } = require("../lib/bridge");
const endpoint = require("../lib/endpoint");

describe("lumine-mcp", () => {
  let mainModule, lumineHome, originalLumineHome;

  beforeEach(async () => {
    // Migration reads LUMINE_HOME afresh. Point it at scratch space so package
    // activation never touches endpoint records belonging to a real window.
    originalLumineHome = process.env.LUMINE_HOME;
    lumineHome = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-mcp-home-"));
    process.env.LUMINE_HOME = lumineHome;

    // Keep the bridge from grabbing a real port on activation.
    lumine.config.set("lumine-mcp.autoStart", false);
    const activation = lumine.packages.activatePackage("lumine-mcp");
    lumine.packages.triggerDeferredActivationHooks();
    lumine.packages.triggerActivationHook("core:loaded-shell-environment");
    mainModule = (await activation).mainModule;
  });

  afterEach(() => {
    if (originalLumineHome === undefined) delete process.env.LUMINE_HOME;
    else process.env.LUMINE_HOME = originalLumineHome;
    fs.rmSync(lumineHome, { recursive: true, force: true, maxRetries: 3 });
  });

  describe("lumine-mcp service", () => {
    it("registers the bridge and client setup commands on the workspace", () => {
      const workspace = lumine.views.getView(lumine.workspace);
      const commands = lumine.commands
        .findCommands({ target: workspace })
        .map((command) => command.name);
      expect(commands).toContain("lumine-mcp:toggle-tools");
      expect(commands).toContain("lumine-mcp:start");
      expect(commands).toContain("lumine-mcp:stop");
      expect(commands).toContain("lumine-mcp:status");
      expect(commands).toContain("lumine-mcp:register-to-claude");
      expect(commands).toContain("lumine-mcp:register-to-codex");
    });

    it("exposes the bridge state accessors", () => {
      const service = mainModule.provideMcpBridge();
      expect(typeof service.getBridgePort).toBe("function");
      expect(typeof service.getBridgePortWhenReady).toBe("function");
      expect(typeof service.isRunning).toBe("function");
      expect(typeof service.getServerPath).toBe("function");

      expect(service.isRunning()).toBe(false);
      expect(service.getBridgePort()).toBeNull();
      expect(path.basename(service.getServerPath())).toBe("server.js");
    });

    it("returns null from the asynchronous accessor while the bridge is stopped", async () => {
      expect(await mainModule.provideMcpBridge().getBridgePortWhenReady()).toBeNull();
    });

    it("coalesces startup with asynchronous port consumers", async () => {
      const starting = mainModule.startBridge();
      const duplicate = mainModule.startBridge();
      const port = await mainModule.provideMcpBridge().getBridgePortWhenReady();
      const bridge = await starting;

      expect(await duplicate).toBe(bridge);
      expect(port).toBe(bridge.port);
      expect(mainModule.bridge).toBe(bridge);

      await mainModule.stopBridge();
      expect(await mainModule.provideMcpBridge().getBridgePortWhenReady()).toBeNull();
    });

    it("shows and copies only the listening address", async () => {
      const write = spyOn(lumine.clipboard, "write");
      const bridge = await mainModule.startBridge();
      lumine.notifications.clear();

      mainModule.showStatus();
      const [notification] = lumine.notifications.getNotifications();
      const detail = notification.getDetail();
      expect(detail).toContain(`Port: ${bridge.port}`);
      expect(detail).toContain(`Host: ${bridge.host}`);
      expect(detail).toContain("ConnectToLumine");
      expect(detail).not.toContain(bridge.token);
      expect(detail).not.toContain("Endpoint:");

      const [button] = notification.getOptions().buttons;
      expect(button.text).toBe("Copy Port");
      button.onDidClick();
      expect(write).toHaveBeenCalledWith(String(bridge.port));

      await mainModule.stopBridge();
    });
  });

  describe("legacy endpoint cleanup", () => {
    it("removes recognized numeric endpoint records and preserves foreign files", () => {
      const registry = path.join(lumineHome, "mcp");
      fs.mkdirSync(registry);
      fs.writeFileSync(
        path.join(registry, "3000.json"),
        JSON.stringify({
          port: 3000,
          host: "127.0.0.1",
          token: "live-or-stale-does-not-matter",
          pid: process.pid,
          updatedAt: Date.now(),
        }),
      );
      fs.writeFileSync(
        path.join(registry, "3001.json"),
        JSON.stringify({ port: 9999, token: "x" }),
      );
      fs.writeFileSync(
        path.join(registry, "3002.json"),
        JSON.stringify({ port: 3002, token: "x" }),
      );
      fs.writeFileSync(path.join(registry, "notes.txt"), "not mine");
      fs.writeFileSync(path.join(registry, "broken.json"), "{ half writ");

      expect(endpoint.cleanupLegacyRegistry(registry)).toBe(1);
      expect(fs.existsSync(path.join(registry, "3000.json"))).toBe(false);
      expect(fs.existsSync(path.join(registry, "3001.json"))).toBe(true);
      expect(fs.existsSync(path.join(registry, "3002.json"))).toBe(true);
      expect(fs.existsSync(path.join(registry, "notes.txt"))).toBe(true);
      expect(fs.existsSync(path.join(registry, "broken.json"))).toBe(true);
    });

    it("removes the legacy directory when no files remain", () => {
      const registry = path.join(lumineHome, "mcp");
      fs.mkdirSync(registry);
      fs.writeFileSync(
        path.join(registry, "3000.json"),
        JSON.stringify({
          port: 3000,
          host: "127.0.0.1",
          token: "x",
          pid: process.pid,
          updatedAt: Date.now(),
        }),
      );

      expect(endpoint.cleanupLegacyRegistry(registry)).toBe(1);
      expect(fs.existsSync(registry)).toBe(false);
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
    const raw = (route, headers = {}, method = "GET", body = null) =>
      new Promise((resolve, reject) => {
        const request = require("http").request(
          { host: "127.0.0.1", port: bridge.port, path: route, method, headers },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response));
          },
        );
        request.on("error", reject);
        if (body) request.write(body);
        request.end();
      });

    const authorizationNotification = () =>
      lumine.notifications
        .getNotifications()
        .find(
          (notification) =>
            !notification.isDismissed() && notification.getMessage().startsWith("Allow MCP client"),
        );

    const waitForAuthorizationNotification = async () => {
      await conditionPromise(() => authorizationNotification());
      return authorizationNotification();
    };

    beforeEach(async () => {
      jasmine.useRealClock();
      // Port 0 lets the OS assign a free ephemeral port: no CI collisions.
      bridge = await startBridge({ port: 0 });
      base = `http://127.0.0.1:${bridge.port}`;
      auth = { Authorization: `Bearer ${bridge.token}` };
      lumine.notifications.clear();
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

      it("refuses browser origins before offering authorization", async () => {
        const response = await raw(
          "/authorize",
          { Origin: "https://evil.example", "Content-Type": "application/json" },
          "POST",
          JSON.stringify({ clientName: "Browser" }),
        );
        expect(response.statusCode).toBe(403);
        expect(authorizationNotification()).toBeUndefined();
      });
    });

    describe("authorization", () => {
      const authorize = (clientName = "Spec client") =>
        fetch(`${base}/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientName }),
        });

      it("hands out the run token only after the user allows the named client", async () => {
        const pending = authorize("Terminal agent");
        const notification = await waitForAuthorizationNotification();

        expect(notification.getDetail()).toContain("Terminal agent");
        expect(notification.getDetail()).not.toContain(bridge.token);
        expect(notification.getOptions().buttons.map((button) => button.text)).toEqual([
          "Allow",
          "Deny",
        ]);

        notification.getOptions().buttons[0].onDidClick();
        const response = await pending;
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ authorized: true, token: bridge.token });
      });

      it("returns 403 when the user denies the request", async () => {
        const pending = authorize();
        const notification = await waitForAuthorizationNotification();
        notification.getOptions().buttons[1].onDidClick();

        expect((await pending).status).toBe(403);
      });

      it("treats dismissing the notification as denial", async () => {
        const pending = authorize();
        const notification = await waitForAuthorizationNotification();
        notification.dismiss();

        expect((await pending).status).toBe(403);
      });

      it("allows only one pending request in this window", async () => {
        const first = authorize("First client");
        const notification = await waitForAuthorizationNotification();
        const second = await authorize("Second client");

        expect(second.status).toBe(409);
        notification.getOptions().buttons[1].onDidClick();
        expect((await first).status).toBe(403);
      });

      it("withdraws the prompt when the requesting client disconnects", async () => {
        const controller = new AbortController();
        const pending = fetch(`${base}/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientName: "Gone client" }),
          signal: controller.signal,
        });
        const notification = await waitForAuthorizationNotification();

        controller.abort();
        await expectAsync(pending).toBeRejected();
        await conditionPromise(() => notification.isDismissed());

        const next = authorize("Next client");
        const nextNotification = await waitForAuthorizationNotification();
        nextNotification.getOptions().buttons[1].onDidClick();
        expect((await next).status).toBe(403);
      });

      it("returns 408 when approval times out", async () => {
        await stopBridge(bridge);
        bridge = await startBridge({ port: 0, authorizationTimeoutMs: 5 });
        base = `http://127.0.0.1:${bridge.port}`;
        auth = { Authorization: `Bearer ${bridge.token}` };
        lumine.notifications.clear();

        expect((await authorize()).status).toBe(408);
      });

      it("returns 503 when the bridge stops with a request pending", async () => {
        const pending = authorize();
        await waitForAuthorizationNotification();

        const stopping = stopBridge(bridge);
        bridge = null;
        expect((await pending).status).toBe(503);
        await stopping;
      });

      it("rejects malformed authorization JSON without showing a prompt", async () => {
        const response = await fetch(`${base}/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{nope",
        });

        expect(response.status).toBe(400);
        expect(authorizationNotification()).toBeUndefined();
      });

      it("rejects an oversized authorization request without showing a prompt", async () => {
        const response = await fetch(`${base}/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientName: "x".repeat(5000) }),
        });

        expect(response.status).toBe(400);
        expect(authorizationNotification()).toBeUndefined();
      });
    });

    it("does not create an endpoint registry", () => {
      expect(fs.existsSync(path.join(lumineHome, "mcp"))).toBe(false);
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

    it("reserves ConnectToLumine against external providers", async () => {
      const disposable = mainModule.consumeMcpTools([
        { name: "ConnectToLumine", execute: () => ({ token: "not allowed" }) },
      ]);

      const { tools } = await (await get("/tools")).json();
      expect(tools.map((tool) => tool.name)).not.toContain("ConnectToLumine");
      disposable.dispose();
    });

    // The shim owns the host-facing lifecycle so it can offer a connector
    // before any editor has been selected. Its hidden bridge session begins
    // only after that window's user approves it.
    describe("the stdio server", () => {
      let server, lines, pending, notifications, notificationWaiters, httpSession, nextId;

      const ask = (message) => {
        const answer = new Promise((resolve) => pending.push(resolve));
        server.stdin.write(JSON.stringify(message) + "\n");
        return answer;
      };

      const tell = (message) => server.stdin.write(JSON.stringify(message) + "\n");

      const waitForNotification = (method) => {
        const existing = notifications.findIndex((message) => message.method === method);
        if (existing !== -1) return Promise.resolve(notifications.splice(existing, 1)[0]);
        return new Promise((resolve) => notificationWaiters.push({ method, resolve }));
      };

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

      const spawnServer = (env = {}) => {
        const child = require("child_process").spawn(
          process.execPath,
          [path.join(__dirname, "..", "lib", "server.js")],
          {
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: "1",
              LUMINE_BRIDGE_PORT: String(bridge.port),
              // Deliberately present: credentials inherited from an old setup
              // must never bypass the new approval flow.
              LUMINE_BRIDGE_TOKEN: bridge.token,
              ...env,
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        require("readline")
          .createInterface({ input: child.stdout })
          .on("line", (line) => {
            const message = JSON.parse(line);
            lines.push(message);
            if (message.method && message.id === undefined) {
              const waiter = notificationWaiters.findIndex(
                (candidate) => candidate.method === message.method,
              );
              if (waiter === -1) notifications.push(message);
              else notificationWaiters.splice(waiter, 1)[0].resolve(message);
            } else {
              pending.shift()?.(message);
            }
          });
        return child;
      };

      const stopServer = async () => {
        if (!server) return;
        const child = server;
        server = null;
        child.stdin.end();
        await new Promise((resolve) => child.once("exit", resolve));
      };

      const restartServer = async (env = {}) => {
        await stopServer();
        lines = [];
        pending = [];
        notifications = [];
        notificationWaiters = [];
        server = spawnServer(env);
      };

      const initializeShim = async () => {
        const answer = await ask(INITIALIZE);
        tell({ jsonrpc: "2.0", method: "notifications/initialized" });
        return answer;
      };

      const connectShim = async ({ port, allow = true } = {}) => {
        const id = nextId++;
        const connecting = ask({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "ConnectToLumine",
            arguments: port === undefined ? {} : { port },
          },
        });
        const notification = await waitForAuthorizationNotification();
        notification.getOptions().buttons[allow ? 0 : 1].onDidClick();
        return connecting;
      };

      beforeEach(() => {
        jasmine.useRealClock();
        lines = [];
        pending = [];
        notifications = [];
        notificationWaiters = [];
        httpSession = null;
        nextId = 10;
        server = spawnServer();
      });

      afterEach(() => stopServer());

      it("answers initialize exactly as the bridge does", async () => {
        expect(await ask(INITIALIZE)).toEqual(await overHttp(INITIALIZE));
      });

      it("starts disconnected with only ConnectToLumine", async () => {
        await initializeShim();
        const answer = await ask({ jsonrpc: "2.0", id: 2, method: "tools/list" });

        expect(answer.result.tools.map((tool) => tool.name)).toEqual(["ConnectToLumine"]);
        expect(authorizationNotification()).toBeUndefined();
      });

      it("uses the terminal port only as the default for an approved connection", async () => {
        await initializeShim();
        const connected = await connectShim();
        expect(connected.result.isError).toBe(false);
        expect(connected.result.content[0].text).toContain(String(bridge.port));

        const answer = await ask({ jsonrpc: "2.0", id: 3, method: "tools/list" });
        const names = answer.result.tools.map((tool) => tool.name);
        expect(names[0]).toBe("ConnectToLumine");
        expect(names).toContain("GetActiveEditor");
        expect(JSON.stringify(lines)).not.toContain(bridge.token);
      });

      it("requires an explicit port without the terminal environment", async () => {
        await restartServer({ LUMINE_BRIDGE_PORT: "", LUMINE_BRIDGE_TOKEN: bridge.token });
        await initializeShim();

        const missing = await ask({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "ConnectToLumine", arguments: {} },
        });
        expect(missing.result.isError).toBe(true);
        expect(authorizationNotification()).toBeUndefined();

        const connected = await connectShim({ port: bridge.port });
        expect(connected.result.isError).toBe(false);
      });

      it("keeps the current window when a switch is denied", async () => {
        const otherBridge = await startBridge({ port: 0 });
        try {
          await initializeShim();
          await connectShim();
          const denied = await connectShim({ port: otherBridge.port, allow: false });

          expect(denied.result.isError).toBe(true);
          const answer = await ask({ jsonrpc: "2.0", id: 5, method: "tools/list" });
          expect(answer.result.tools.map((tool) => tool.name)).toContain("GetActiveEditor");
        } finally {
          await stopBridge(otherBridge);
        }
      });

      it("switches to another approved window and does not fall back when it closes", async () => {
        let otherBridge = await startBridge({ port: 0 });
        try {
          await initializeShim();
          await connectShim();
          const switched = await connectShim({ port: otherBridge.port });
          expect(switched.result.content[0].text).toContain("Switched");

          await waitForNotification("notifications/tools/list_changed");
          const changed = waitForNotification("notifications/tools/list_changed");
          await stopBridge(otherBridge);
          otherBridge = null;
          await changed;

          const answer = await ask({ jsonrpc: "2.0", id: 6, method: "tools/list" });
          expect(answer.result.tools.map((tool) => tool.name)).toEqual(["ConnectToLumine"]);
        } finally {
          if (otherBridge) await stopBridge(otherBridge);
        }
      });

      it("relays notifications from the selected bridge", async () => {
        await initializeShim();
        await connectShim();
        await waitForNotification("notifications/tools/list_changed");
        await conditionPromise(() => openStreamCount() > 0);
        const relayed = waitForNotification("notifications/tools/list_changed");
        setExternalTools(new Map([["SpecTool", { name: "SpecTool", execute: () => null }]]));
        expect(await relayed).toEqual({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
        });
      });

      it("answers ping without selecting a window", async () => {
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
        tell({ jsonrpc: "2.0", method: "notifications/initialized" });
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

      it("cancels a pending approval when the MCP host exits", async () => {
        await initializeShim();
        ask({
          jsonrpc: "2.0",
          id: 20,
          method: "tools/call",
          params: { name: "ConnectToLumine", arguments: {} },
        });
        const notification = await waitForAuthorizationNotification();
        const child = server;
        server = null;

        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.stdin.end();
        await exited;
        await conditionPromise(() => notification.isDismissed());
      });
    });
  });
});
