const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const timers = require("node:timers");

// This file also runs with `node --test spec/cancellation-spec.js`: the stdio
// server and the test-only HTTP fixture need no editor or native modules.
function test(name, body) {
  if (typeof jasmine === "undefined") {
    require("node:test").test(name, { timeout: 15000 }, body);
  } else {
    it(
      name,
      async () => {
        jasmine.useRealClock();
        await body();
      },
      15000,
    );
  }
}

function deadline(promise, description, timeout = 3000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = timers.setTimeout(
        () => reject(new Error(`Timed out waiting for ${description}`)),
        timeout,
      );
    }),
  ]).finally(() => timers.clearTimeout(timer));
}

async function waitFor(condition, description, timeout = 3000) {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > timeout)
      throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => timers.setTimeout(resolve, 10));
  }
}

async function fixture() {
  const state = {
    initializationPending: false,
    initializationClosed: false,
    initializedNotifications: 0,
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url === "/authorize") {
        // A private test fixture, never the production approval endpoint.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token: "fixture-token" }));
        return;
      }
      const message = body ? JSON.parse(body) : {};
      if (message.method === "initialize") {
        state.initializationPending = true;
        res.once("close", () => {
          state.initializationClosed = true;
        });
        // Deliberately no response: cancellation must release this request.
        return;
      }
      if (message.method === "notifications/initialized") state.initializedNotifications++;
      res.writeHead(202);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, [path.join(__dirname, "..", "lib", "server.js")], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      LUMINE_BRIDGE_PORT: String(server.address().port),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const messages = [];
  const pending = new Map();
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const tell = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const ask = (message) =>
    deadline(
      new Promise((resolve) => {
        pending.set(message.id, resolve);
        tell(message);
      }),
      `${message.method} response (${stderr.slice(0, 1000)})`,
    );
  return {
    state,
    child,
    messages,
    exited,
    tell,
    ask,
    async initialize() {
      await ask({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "cancellation fixture", version: "1" },
        },
      });
      tell({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    connect() {
      tell({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ConnectToLumine", arguments: {} },
      });
    },
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        try {
          await deadline(exited, "stdio shutdown");
        } catch {
          child.kill();
          await exited;
        }
      }
      lines.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("cancelling ConnectToLumine after authorization aborts backend initialization and releases the control barrier", async () => {
  const harness = await fixture();
  try {
    await harness.initialize();
    harness.connect();
    await waitFor(() => harness.state.initializationPending, "backend initialization");
    harness.tell({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
    const result = await harness.ask({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    assert.deepEqual(
      result.result.tools.map((tool) => tool.name),
      ["ConnectToLumine"],
    );
    await waitFor(() => harness.state.initializationClosed, "cancelled HTTP initialization socket");
    assert.equal(
      harness.messages.some((message) => message.id === 2),
      false,
    );
    assert.equal(harness.state.initializedNotifications, 0);
  } finally {
    await harness.dispose();
  }
});

test("stdio EOF after authorization aborts pending backend initialization and exits promptly", async () => {
  const harness = await fixture();
  try {
    await harness.initialize();
    harness.connect();
    await waitFor(() => harness.state.initializationPending, "backend initialization");
    harness.child.stdin.end();
    const exit = await deadline(harness.exited, "stdio EOF shutdown");
    assert.equal(exit.code, 0);
    await waitFor(() => harness.state.initializationClosed, "closed HTTP initialization socket");
    assert.equal(harness.state.initializedNotifications, 0);
  } finally {
    await harness.dispose();
  }
});
