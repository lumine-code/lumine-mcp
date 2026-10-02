const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

describe("Jupyter tools over the live MCP bridge", () => {
  const peers = ["jupyter-repl", "jupyter-view", "jupyter-variables", "jupyter-watches"];
  let bridge, bridgeApi, modules, session, nextId, kernel, store;

  async function activate(name) {
    const sibling = path.resolve(__dirname, "../..", name);
    const pack = await lumine.packages.activatePackage(fs.existsSync(sibling) ? sibling : name);
    return pack.mainModule;
  }

  async function rpc(method, params = {}) {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        "Content-Type": "application/json",
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    session ||= response.headers.get("mcp-session-id");
    return response.json();
  }

  async function call(name, args = {}) {
    const answer = await rpc("tools/call", { name, arguments: args });
    if (answer.result?.isError || answer.error)
      throw new Error(answer.result?.content?.[0]?.text || answer.error?.message);
    return answer.result.structuredContent ?? JSON.parse(answer.result.content[0].text);
  }

  beforeEach(async () => {
    jasmine.useRealClock();
    lumine.config.set("lumine-mcp.autoStart", false);
    for (const name of ["language-python", "language-text", "language-json", "language-gfm"]) {
      const grammarPackage = await lumine.packages.activatePackage(name);
      await grammarPackage.resourceLoadPromise;
    }
    modules = { "lumine-mcp": await activate("lumine-mcp") };
    lumine.hooks.trigger("core:loaded-shell-environment");
    for (const name of peers) modules[name] = await activate(name);
    bridgeApi = require("../lib/bridge");
    bridge = await bridgeApi.startBridge({ port: 0 });
    session = null;
    nextId = 1;
    await rpc("initialize", {
      protocolVersion: "2025-11-25",
      clientInfo: { name: "Jupyter integration spec" },
    });
  });

  afterEach(async () => {
    if (store && kernel) {
      store.runningKernels = store.runningKernels.filter((entry) => entry !== kernel);
      kernel.destroy();
    }
    store = kernel = null;
    for (const item of [...lumine.workspace.getPaneItems()]) {
      if (item.document && item.getURI?.()?.includes("jupyter")) item.destroy?.();
    }
    await bridgeApi.stopBridge(bridge);
    for (const name of [...peers].reverse()) await lumine.packages.deactivatePackage(name);
    await lumine.packages.deactivatePackage("lumine-mcp");
  });

  it("publishes every provider and withdraws cached-data tools on deactivation", async () => {
    let names = (await rpc("tools/list")).result.tools.map((tool) => tool.name);
    for (const name of [
      "ListJupyterNotebooks",
      "EditJupyterCell",
      "RunJupyterCell",
      "GetJupyterExecution",
      "ListJupyterVariables",
      "GetJupyterWatch",
    ])
      expect(names).toContain(name);
    await lumine.packages.deactivatePackage("jupyter-variables");
    names = (await rpc("tools/list")).result.tools.map((tool) => tool.name);
    expect(names).not.toContain("ListJupyterVariables");
    expect(names).toContain("RunJupyterCell");
    await activate("jupyter-variables");
    names = (await rpc("tools/list")).result.tools.map((tool) => tool.name);
    expect(names.filter((name) => name === "ListJupyterVariables").length).toBe(1);
  });

  it("edits the same notebook the human sees, preserves retry receipts and notices changes", async () => {
    const listing = await call("ListJupyterNotebooks");
    const createArgs = {
      expectedGeneration: listing.generation,
      operationId: randomUUID(),
      language: "python",
    };
    const notebook = await call("CreateJupyterNotebook", createArgs);
    const retry = await call("CreateJupyterNotebook", createArgs);
    expect(retry.notebookId).toBe(notebook.notebookId);
    const cellId = notebook.cells[0].cellId;
    const editArgs = {
      notebookId: notebook.notebookId,
      cellId,
      operation: "replace",
      source: "answer = 42",
      expectedRevision: notebook.revision,
      operationId: randomUUID(),
    };
    const edited = await call("EditJupyterCell", editArgs);
    const cell = await call("GetJupyterCell", { notebookId: notebook.notebookId, cellId });
    expect(cell.source.text).toBe("answer = 42");
    const document = modules["jupyter-view"]
      .provideJupyterNotebook()
      .getDocumentRegistry()
      .getDocuments()
      .find((document) => document.id === notebook.notebookId);
    expect(document.cells[0].source).toBe(cell.source.text);
    expect((await call("EditJupyterCell", editArgs)).replayed).toBeTrue();
    const changed = await call("WaitForJupyterNotebookChange", {
      notebookId: notebook.notebookId,
      afterRevision: notebook.changeRevision,
      timeoutMs: 0,
    });
    expect(changed.changed).toBeTrue();
    expect(edited.revision).not.toBe(notebook.revision);
    await expectAsync(
      call("EditJupyterCell", { ...editArgs, operationId: randomUUID() }),
    ).toBeRejectedWithError(/revision/);
    document.getEditors?.().forEach((editor) => editor.destroy());
  });

  it("returns one execution receipt and observes the same output stored by the named kernel", async () => {
    const replPath = lumine.packages.getActivePackage("jupyter-repl").path;
    const Kernel = require(path.join(replPath, "lib/kernel"));
    const Transport = require(path.join(replPath, "lib/kernel-transport"));
    const transport = new Transport(
      { name: "python-mcp-spec", language: "python", display_name: "Python spec" },
      lumine.grammars.grammarForScopeName("source.python") ||
        lumine.grammars.grammarForScopeName("text.plain"),
    );
    transport.setLifecycle("ready");
    transport.setExecutionState("idle");
    transport.ownsKernelProcess = false;
    let receive;
    transport.execute = jasmine.createSpy("execute").and.callFake((_code, callback) => {
      receive = callback;
    });
    kernel = new Kernel(transport);
    store = require(path.join(replPath, "lib/store"));
    store.runningKernels.push(kernel);
    const args = { kernelId: kernel.id, operationId: randomUUID(), code: "print('MCP')" };
    const receipt = await call("ExecuteJupyterCode", args);
    expect(receipt.accepted).toBeTrue();
    await conditionPromise(() => receive);
    expect((await call("ExecuteJupyterCode", args)).executionId).toBe(receipt.executionId);
    expect(transport.execute.calls.count()).toBe(1);
    expect(transport.execute.calls.first().args[0]).toBe(args.code);
    const wire = (type, content, channel) =>
      receive(
        {
          header: { msg_type: type, msg_id: randomUUID() },
          parent_header: { msg_type: "execute_request", msg_id: "mcp-spec-execute" },
          content,
        },
        channel,
      );
    wire("execute_input", { execution_count: 42 }, "iopub");
    wire("stream", { name: "stdout", text: "MCP\n" }, "iopub");
    wire("execute_reply", { status: "ok", execution_count: 42 }, "shell");
    wire("status", { execution_state: "idle" }, "iopub");
    const result = await call("GetJupyterExecution", {
      executionId: receipt.executionId,
      waitMs: 1000,
    });
    expect(result.state).toBe("done");
    expect(JSON.stringify(result.outputs)).toContain("MCP");
    expect(kernel.outputStore.outputs[0].text).toBe("MCP\n");
    expect((await call("ListJupyterVariables", { kernelId: kernel.id })).status).toBe(
      "cache-unavailable",
    );
    expect((await call("ListJupyterWatches", { kernelId: kernel.id })).watches).toEqual([]);

    const generation = (await call("ListJupyterNotebooks")).generation;
    const created = await call("CreateJupyterNotebook", {
      expectedGeneration: generation,
      operationId: randomUUID(),
    });
    const cellId = created.cells[0].cellId;
    const edited = await call("EditJupyterCell", {
      notebookId: created.notebookId,
      cellId,
      operation: "replace",
      source: "print('MCP')",
      expectedRevision: created.revision,
      operationId: randomUUID(),
    });
    const binding = await call("BindJupyterNotebookKernel", {
      notebookId: created.notebookId,
      kernelId: kernel.id,
      expectedRevision: edited.revision,
      operationId: randomUUID(),
    });
    expect(binding.accepted).toBeTrue();
    let bound = await call("GetJupyterExecution", {
      executionId: binding.executionId,
      waitMs: 1000,
    });
    while (bound.state !== "done" && bound.state !== "error")
      bound = await call("GetJupyterExecution", {
        executionId: binding.executionId,
        afterVersion: bound.version,
        waitMs: 1000,
      });
    expect(bound.state).toBe("done");
    expect(bound.error).toBeUndefined();
    const cellRun = await call("RunJupyterCell", {
      notebookId: created.notebookId,
      cellId,
      kernelId: kernel.id,
      expectedRevision: bound.binding.revision,
      operationId: randomUUID(),
    });
    expect(cellRun.accepted).toBeTrue();
    await conditionPromise(() => transport.execute.calls.count() === 2);
    wire("execute_input", { execution_count: 43 }, "iopub");
    wire("stream", { name: "stdout", text: "Notebook MCP\n" }, "iopub");
    wire("execute_reply", { status: "ok", execution_count: 43 }, "shell");
    wire("status", { execution_state: "idle" }, "iopub");
    const completed = await call("GetJupyterExecution", {
      executionId: cellRun.executionId,
      waitMs: 1000,
    });
    expect(completed.state).toBe("done");
    const visibleCell = await call("GetJupyterCell", { notebookId: created.notebookId, cellId });
    expect(visibleCell.executionCount).toBe(43);
    expect(visibleCell.outputs[0].text.text).toBe("Notebook MCP\n");
  });
});
