const http = require("node:http");

describe("MCP bridge port allocation", () => {
  let bridgeApi;
  let bridges;
  let servers;

  beforeEach(() => {
    jasmine.useRealClock();
    bridgeApi = require("../lib/bridge");
    bridges = [];
    servers = [];
  });

  afterEach(async () => {
    await Promise.all(bridges.map((bridge) => bridgeApi.stopBridge(bridge)));
    await Promise.all(servers.map((server) => close(server)));
  });

  async function close(server) {
    if (!server.listening) return;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  async function occupyPort() {
    const server = http.createServer((_request, response) => response.end("occupied"));
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return { server, port: server.address().port };
  }

  async function freePort() {
    const { server, port } = await occupyPort();
    await close(server);
    return port;
  }

  async function start(port) {
    const bridge = await bridgeApi.startBridge({ port });
    bridges.push(bridge);
    return bridge;
  }

  async function expectHealthy(bridge) {
    const response = await fetch(`http://${bridge.host}:${bridge.port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("ok");
  }

  function refuseListen(error) {
    const attempts = [];
    const createServer = http.createServer;
    spyOn(http, "createServer").and.callFake((...args) => {
      const server = createServer(...args);
      servers.push(server);
      server.listen = (port) => {
        attempts.push(port);
        queueMicrotask(() => server.emit("error", error));
        return server;
      };
      return server;
    });
    return attempts;
  }

  it("keeps a port claimed when another window reaches the same bind", async () => {
    const port = await freePort();
    const createServer = http.createServer;
    const pending = [];
    let reachedFirstBind;
    const firstBind = new Promise((resolve) => {
      reachedFirstBind = resolve;
    });
    spyOn(http, "createServer").and.callFake((...args) => {
      const server = createServer(...args);
      servers.push(server);
      if (server.listenerCount("request") === 0) return server;
      const listen = server.listen;
      server.listen = function (...listenArgs) {
        if (listenArgs[0] !== port) return listen.apply(this, listenArgs);
        pending.push(() => listen.apply(this, listenArgs));
        if (pending.length === 1) reachedFirstBind();
        if (pending.length === 2) {
          for (const bind of pending.splice(0)) bind();
        }
        return this;
      };
      return server;
    });

    // Hold the first real HTTP bind before starting the second window. With
    // the old probe-and-close allocator both probes now see the same free
    // port, so releasing the binds deterministically exposes EADDRINUSE.
    const first = start(port);
    await firstBind;
    const results = await Promise.allSettled([first, start(port)]);

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const running = results.filter((result) => result.status === "fulfilled");
    expect(new Set(running.map((result) => result.value.port)).size).toBe(2);
    for (const result of running) await expectHealthy(result.value);
  });

  it("starts several simultaneous windows on distinct working ports", async () => {
    const port = await freePort();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => start(port)));

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const running = results.filter((result) => result.status === "fulfilled");
    expect(new Set(running.map((result) => result.value.port)).size).toBe(6);
    for (const result of running) await expectHealthy(result.value);
  });

  it("skips an occupied base port without disturbing its listener", async () => {
    const { port } = await occupyPort();
    const bridge = await start(port);

    expect(bridge.port).toBeGreaterThan(port);
    await expectHealthy(bridge);
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(await response.text()).toBe("occupied");
  });

  it("releases its port when stopped so a new bridge can bind it", async () => {
    const bridge = await start(0);
    const port = bridge.port;
    await expectHealthy(bridge);
    await bridgeApi.stopBridge(bridge);
    bridges.splice(bridges.indexOf(bridge), 1);

    const replacement = await start(port);
    expect(replacement.port).toBe(port);
    await expectHealthy(replacement);
  });

  it("propagates a bind failure other than EADDRINUSE without trying another port", async () => {
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const attempts = refuseListen(failure);

    await expectAsync(bridgeApi.startBridge({ port: 3000 })).toBeRejectedWith(failure);
    expect(attempts).toEqual([3000]);
  });

  it("limits an exhausted scan to 100 occupied ports", async () => {
    const failure = Object.assign(new Error("address in use"), { code: "EADDRINUSE" });
    const attempts = refuseListen(failure);

    await expectAsync(bridgeApi.startBridge({ port: 3000 })).toBeRejected();
    expect(attempts).toEqual(Array.from({ length: 100 }, (_, index) => 3000 + index));
  });

  it("stops scanning at the highest TCP port", async () => {
    const failure = Object.assign(new Error("address in use"), { code: "EADDRINUSE" });
    const attempts = refuseListen(failure);

    await expectAsync(bridgeApi.startBridge({ port: 65534 })).toBeRejected();
    expect(attempts).toEqual([65534, 65535]);
  });

  it("makes only one attempt when the OS is asked to choose an ephemeral port", async () => {
    const failure = Object.assign(new Error("address in use"), { code: "EADDRINUSE" });
    const attempts = refuseListen(failure);

    await expectAsync(bridgeApi.startBridge({ port: 0 })).toBeRejected();
    expect(attempts).toEqual([0]);
  });
});
