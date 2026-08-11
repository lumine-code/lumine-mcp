const fs = require("fs");
const os = require("os");
const path = require("path");
const { startBridge, stopBridge, setExternalTools } = require("../lib/bridge");

// What the toggle list says and what the bridge serves are two answers to the
// same question, and they used to be able to disagree: an empty greenlist read
// as everybody allowed, so "disable all" in greenlist mode drew a cross beside
// every tool and enabled every one of them. These hold the two together.
describe("lumine-mcp tool list", () => {
  let view, bridge, base, auth, registry, originalRegistry;

  const servedTools = async () => {
    const response = await fetch(`${base}/tools`, { headers: auth });
    const { tools } = await response.json();
    return tools.map((tool) => tool.name).sort();
  };

  // What the toggle list draws a check beside, by the same rule its rows use.
  const shownAsEnabled = () =>
    view
      .getTools()
      .filter((tool) => {
        const inList = view.toolList.includes(tool.name);
        return view.listMode === "greenlist" ? inList : !inList;
      })
      .map((tool) => tool.name)
      .sort();

  beforeEach(async () => {
    originalRegistry = process.env.LUMINE_MCP_REGISTRY;
    registry = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-mcp-registry-"));
    process.env.LUMINE_MCP_REGISTRY = registry;

    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    lumine.config.set("lumine-mcp.autoStart", false);
    const activation = lumine.packages.activatePackage("lumine-mcp");
    lumine.packages.triggerDeferredActivationHooks();
    lumine.packages.triggerActivationHook("core:loaded-shell-environment");
    view = (await activation).mainModule.toggleToolsView;

    bridge = await startBridge({ port: 0 });
    base = `http://127.0.0.1:${bridge.port}`;
    auth = { Authorization: `Bearer ${bridge.token}` };

    // Shows the list, which is what syncs the view from config.
    view.toggle();
  });

  afterEach(async () => {
    setExternalTools(new Map());
    await stopBridge(bridge);
    if (originalRegistry === undefined) delete process.env.LUMINE_MCP_REGISTRY;
    else process.env.LUMINE_MCP_REGISTRY = originalRegistry;
    fs.rmSync(registry, { recursive: true, force: true, maxRetries: 3 });
  });

  describe("a blacklist", () => {
    it("serves everything that is not on it", async () => {
      expect(await servedTools()).not.toContain("CloseFile");
      expect(await servedTools()).toContain("GetActiveEditor");
      expect(await servedTools()).toEqual(shownAsEnabled());
    });

    it("turns a tool off and on again", async () => {
      view.toggleTool("GetActiveEditor");
      expect(await servedTools()).not.toContain("GetActiveEditor");

      view.toggleTool("GetActiveEditor");
      expect(await servedTools()).toContain("GetActiveEditor");
    });

    it("serves nothing after disable-all", async () => {
      view.disableAll();
      expect(await servedTools()).toEqual([]);
      expect(shownAsEnabled()).toEqual([]);
    });

    it("serves everything after enable-all", async () => {
      view.enableAll();
      expect(await servedTools()).toContain("CloseFile");
      expect(await servedTools()).toEqual(shownAsEnabled());
    });
  });

  describe("a greenlist", () => {
    beforeEach(() => {
      lumine.config.set("lumine-mcp.listMode", "greenlist");
      lumine.config.set("lumine-mcp.toolList", ["GetActiveEditor"]);
      view.toggle();
      view.toggle();
    });

    it("serves only what is on it", async () => {
      expect(await servedTools()).toEqual(["GetActiveEditor"]);
      expect(await servedTools()).toEqual(shownAsEnabled());
    });

    // The one that used to invert: an empty greenlist read as everybody.
    it("serves nothing after disable-all", async () => {
      view.disableAll();
      expect(view.toolList).toEqual([]);
      expect(await servedTools()).toEqual([]);
      expect(shownAsEnabled()).toEqual([]);
    });

    it("serves everything after enable-all", async () => {
      view.enableAll();
      expect(await servedTools()).toContain("CloseFile");
      expect(await servedTools()).toEqual(shownAsEnabled());
    });
  });

  describe("switching mode", () => {
    // Taking the list at face value across the switch turned every enabled
    // tool off and every disabled one on — on the defaults that left exactly
    // CloseFile and RemoveProjectPath enabled.
    it("keeps the same tools enabled", async () => {
      const before = await servedTools();
      view.toggleMode();
      expect(view.listMode).toBe("greenlist");
      expect(await servedTools()).toEqual(before);
      expect(shownAsEnabled()).toEqual(before);
    });

    it("keeps them enabled on the way back too", async () => {
      view.toggleTool("GetOpenEditors");
      const before = await servedTools();
      view.toggleMode();
      view.toggleMode();
      expect(view.listMode).toBe("blacklist");
      expect(await servedTools()).toEqual(before);
    });

    // Which is the whole point of the mode: what happens to a tool that
    // arrives after the user has finished ruling on the ones they can see.
    it("decides whether a tool registered later arrives on or off", async () => {
      const later = new Map([["LaterTool", { name: "LaterTool", execute: () => null }]]);

      setExternalTools(later);
      expect(await servedTools()).toContain("LaterTool");

      setExternalTools(new Map());
      view.toggleMode();
      setExternalTools(later);
      expect(await servedTools()).not.toContain("LaterTool");
    });
  });

  describe("reset-defaults", () => {
    it("puts back the list and the mode the package ships with", async () => {
      view.toggleMode();
      view.disableAll();

      view.resetDefaults();

      expect(view.listMode).toBe("blacklist");
      // The tools that discard something: a tab, a project root, and — from
      // jupyter-repl, whether or not it is installed — a kernel's variables.
      expect(view.toolList).toEqual([
        "CloseFile",
        "RemoveProjectPath",
        "JupyterExecute",
        "JupyterRestart",
      ]);
      const served = await servedTools();
      expect(served).toContain("GetActiveEditor");
      expect(served).not.toContain("CloseFile");
    });
  });
});
