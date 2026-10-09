const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const timers = require("node:timers");

describe("MCP native operation receipts and transport", () => {
  let main, tools, bridgeApi, bridge, directory, file, leases, hub;
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const name of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, name).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    lumine.config.set("lumine-mcp.autoStart", false);
    lumine.config.set("lumine-mcp.toolList", []);
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-owned-receipts-")));
    file = path.join(directory, "owned.txt");
    fs.writeFileSync(file, "original\n");
    main = (await lumine.packages.activatePackage("lumine-mcp")).mainModule;
    const root = lumine.packages.getLoadedPackage("lumine-mcp").path;
    tools = require(path.join(root, "lib", "tools"));
    bridgeApi = require(path.join(root, "lib", "bridge"));
    leases = [];
    hub = new lumine.packages.serviceHub.constructor();
    leases.push(hub.consume("mcp.tools", "^1.0.0", (payload) => main.consumeMcpTools(payload)));
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
  });
  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    if (bridge) await bridgeApi.stopBridge(bridge);
    bridge = null;
    await lumine.packages.deactivatePackage("lumine-mcp");
    for (const editor of lumine.workspace.getTextEditors()) {
      if (editor.getPath()?.startsWith(directory + path.sep)) editor.destroy();
    }
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw Error("Unsafe owned scratch cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    return { promise, resolve };
  };
  async function start() {
    bridge ??= await bridgeApi.startBridge({ port: 0 });
  }
  async function request(name, args = {}) {
    await start();
    return new Promise((resolve, reject) => {
      const client = http.request(
        {
          host: "127.0.0.1",
          port: bridge.port,
          path: `/tools/${name}`,
          method: "POST",
          headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () => resolve(JSON.parse(body)));
        },
      );
      client.on("error", reject);
      client.end(JSON.stringify(args));
    });
  }
  function provide(name, value) {
    const tool = { name, inputSchema: { type: "object" }, execute: () => ({ value }) };
    const lease = hub.provide("mcp.tools", "1.0.0", [tool]);
    leases.push(lease);
    return { tool, lease };
  }

  it("waits for Core close listeners and reports a prevented close", async () => {
    const editor = await lumine.workspace.open(file);
    const gate = deferred();
    leases.push(
      lumine.workspace.onWillDestroyPaneItem((event) => {
        if (event.item !== editor) return;
        event.prevent();
        return gate.promise;
      }),
    );
    let settled = false;
    const closing = tools.executeTool("CloseFile", { path: file });
    closing.then(() => (settled = true));
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      gate.resolve();
    }
    const result = await closing;
    expect(result).toEqual({ success: true, data: { closed: false } });
    expect(editor.isDestroyed()).toBe(false);
  });

  it("preserves edits made after the accepted save before a requested close", async () => {
    const editor = await lumine.workspace.open(file);
    editor.setText("accepted save\n");
    leases.push(editor.getBuffer().onDidSave(() => editor.setText("new unsaved edit\n")));
    const result = await tools.executeTool("CloseFile", { path: file, save: true });
    expect(result).toEqual({ success: true, data: { closed: false } });
    expect(editor.isDestroyed()).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("accepted save\n");
    if (!editor.isDestroyed()) expect(editor.getText()).toBe("new unsaved edit\n");
  });

  it("reports a native large-file open declined by the user", async () => {
    const large = path.join(directory, "large.txt");
    fs.writeFileSync(large, Buffer.alloc(2 * 1048576, 65));
    lumine.config.set("core.warnOnLargeFileLimit", 1);
    spyOn(lumine.applicationDelegate, "confirm").and.resolveTo(1);
    const result = await tools.executeTool("OpenFile", { path: large });
    expect(result.success).toBe(true);
    expect(result.data.opened).toBe(false);
    expect(lumine.workspace.getTextEditors().some((editor) => editor.getPath() === large)).toBe(
      false,
    );
  });

  it("returns an explicit cancellation for a native unsaved editor save", async () => {
    const editor = await lumine.workspace.open();
    editor.setText("owned unsaved source\n");
    const dialog = spyOn(lumine.applicationDelegate, "showSaveDialog").and.resolveTo({
      canceled: true,
    });
    const result = await tools.executeTool("SaveFile");
    expect(result).toEqual({ success: true, data: { saved: false } });
    expect(dialog).toHaveBeenCalled();
    expect(editor.getText()).toBe("owned unsaved source\n");
    expect(editor.isDestroyed()).toBe(false);
  });

  it("saves a native unsaved editor to its accepted owned destination", async () => {
    const editor = await lumine.workspace.open();
    editor.setText("owned accepted source\n");
    const destination = path.join(directory, "accepted.txt");
    spyOn(lumine.applicationDelegate, "showSaveDialog").and.resolveTo({ filePath: destination });
    expect(await tools.executeTool("SaveFile")).toEqual({
      success: true,
      data: { saved: true, path: destination },
    });
    expect(fs.existsSync(destination) ? fs.readFileSync(destination, "utf8") : null).toBe(
      "owned accepted source\n",
    );
  });

  it("preserves a new edit made by an awaited Core close listener", async () => {
    const editor = await lumine.workspace.open(file);
    leases.push(
      lumine.workspace.onWillDestroyPaneItem(async (event) => {
        if (event.item !== editor) return;
        await Promise.resolve();
        editor.setText("edit while closing\n");
      }),
    );
    expect(await tools.executeTool("CloseFile", { path: file, save: true })).toEqual({
      success: true,
      data: { closed: false },
    });
    expect(editor.isDestroyed()).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe("original\n");
  });

  it("keeps a shared tool live after one actual ServiceHub consumer withdraws", async () => {
    provide("OwnedEcho", "shared");
    const second = hub.consume("mcp.tools", "^1.0.0", (payload) => main.consumeMcpTools(payload));
    leases.push(second);
    leases[0].dispose();
    expect(await request("OwnedEcho")).toEqual({ success: true, data: { value: "shared" } });
  });

  it("restores the latest surviving same-name tool in A-B-A registration order", async () => {
    const first = provide("OwnedEcho", "A");
    provide("OwnedEcho", "B");
    const newest = hub.provide("mcp.tools", "1.0.0", [first.tool]);
    leases.push(newest);
    expect((await request("OwnedEcho")).data).toEqual({ value: "A" });
    newest.dispose();
    expect((await request("OwnedEcho")).data).toEqual({ value: "B" });
  });

  it("accepts a contributed tool named like an Object prototype member", async () => {
    provide("toString", "literal tool");
    expect(await request("toString")).toEqual({ success: true, data: { value: "literal tool" } });
  });

  it("withdraws manual tool leases on Package retirement and preserves the next generation", async () => {
    const old = main.consumeMcpTools([{ name: "OwnedManual", execute: () => ({ value: "old" }) }]);
    leases.push(old);
    expect((await request("OwnedManual")).data).toEqual({ value: "old" });
    await lumine.packages.deactivatePackage("lumine-mcp");
    expect((await request("OwnedManual")).success).toBe(false);
    main = (await lumine.packages.activatePackage("lumine-mcp")).mainModule;
    leases.push(main.consumeMcpTools([{ name: "OwnedManual", execute: () => ({ value: "new" }) }]));
    old.dispose();
    expect((await request("OwnedManual")).data).toEqual({ value: "new" });
  });

  it("responds to a malformed native HTTP target without an unhandled rejection", async () => {
    await start();
    const thrown = [];
    leases.push(
      lumine.runtime.onWillThrowError(({ originalError, preventDefault }) => {
        thrown.push(originalError);
        preventDefault();
      }),
    );
    const status = await new Promise((resolve) => {
      const client = http.request(
        {
          host: "127.0.0.1",
          port: bridge.port,
          path: "http://[owned.invalid",
          method: "GET",
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        },
      );
      client.on("error", () => resolve(null));
      client.setTimeout(700, () => client.destroy(new Error("Owned request deadline")));
      client.end();
    });
    expect(status).toBe(500);
    expect(thrown.length).toBe(0);
  });

  it("decodes a Unicode JSON value split inside its UTF8 code point on the native socket", async () => {
    const lease = main.consumeMcpTools([{ name: "OwnedUtf8", execute: (args) => args }]);
    leases.push(lease);
    await start();
    const body = Buffer.from(JSON.stringify({ value: "before € after" }), "utf8");
    const split = body.indexOf(Buffer.from("€")) + 1;
    const reply = await new Promise((resolve, reject) => {
      const client = http.request(
        {
          host: "127.0.0.1",
          port: bridge.port,
          path: "/tools/OwnedUtf8",
          method: "POST",
          headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () => resolve(JSON.parse(text)));
        },
      );
      client.on("error", reject);
      client.write(body.subarray(0, split));
      timers.setTimeout(() => client.end(body.subarray(split)), 30);
    });
    expect(reply).toEqual({ success: true, data: { value: "before € after" } });
  });
});
