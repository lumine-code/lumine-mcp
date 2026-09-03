describe("lumine-mcp item actions", () => {
  let view;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    // Keep the bridge from grabbing a real port on activation.
    lumine.config.set("lumine-mcp.autoStart", false);
    const activation = lumine.packages.activatePackage("lumine-mcp");
    lumine.packages.triggerDeferredActivationHooks();
    lumine.packages.triggerActivationHook("core:loaded-shell-environment");
    view = (await activation).mainModule.toggleToolsView;
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("lumine-mcp");
  });

  it("derives its actions from the command registrations and the keymap", () => {
    const tool = { name: "ReadText", description: "Read an open editor." };
    view.getTools = () => [tool];
    view.selectList.setItems([tool]);
    const actions = view.selectList.getAvailableActions();
    const byCommand = new Map(actions.map((action) => [action.command, action]));

    expect([...byCommand.keys()].sort()).toEqual([
      "lumine-mcp:disable-all",
      "lumine-mcp:enable-all",
      "lumine-mcp:reset-defaults",
      "lumine-mcp:toggle-mode",
      "lumine-mcp:toggle-selected-tool",
    ]);

    const toggleSelected = byCommand.get("lumine-mcp:toggle-selected-tool");
    expect(toggleSelected.name).toBe("Toggle Selected Tool");
    expect(toggleSelected.description).toBe(
      "Enable or disable the selected tool, keeping the list open.",
    );
    expect(toggleSelected.primary).toBe(true);
    expect(toggleSelected.context).toBe("item");

    const toggleMode = byCommand.get("lumine-mcp:toggle-mode");
    expect(toggleMode.name).toBe("Toggle Mode");
    expect(toggleMode.description).toBe(
      "Decide whether a tool arriving later is on or off by default.",
    );
    expect(toggleMode.keystrokes).toEqual(["alt-enter"]);
    expect(byCommand.get("lumine-mcp:enable-all").keystrokes).toEqual(["alt-="]);
    expect(byCommand.get("lumine-mcp:disable-all").keystrokes).toEqual(["alt--"]);
    expect(byCommand.get("lumine-mcp:reset-defaults").keystrokes).toEqual(["alt-0"]);
    for (const command of [
      "lumine-mcp:enable-all",
      "lumine-mcp:disable-all",
      "lumine-mcp:reset-defaults",
      "lumine-mcp:toggle-mode",
    ]) {
      expect(byCommand.get(command).context).toBe("dialog");
    }
    expect(view.selectList.getItemId(tool)).toBe(tool.name);

    // Every action explains itself with more than a restated title.
    for (const action of actions) {
      expect(action.description).toBeTruthy();
    }

    // Chrome and global commands stay out.
    expect(byCommand.has("core:confirm")).toBe(false);
    expect(byCommand.has("select-list:actions")).toBe(false);
    expect(byCommand.has("lumine-mcp:toggle-tools")).toBe(false);
  });

  it("hides the item action when no tool is selected", () => {
    view.selectList.setItems([]);

    expect(
      view.selectList
        .getAvailableActions()
        .map((action) => action.command)
        .sort(),
    ).toEqual([
      "lumine-mcp:disable-all",
      "lumine-mcp:enable-all",
      "lumine-mcp:reset-defaults",
      "lumine-mcp:toggle-mode",
    ]);
  });

  it("shows the actions as a flow step and runs one against the master list", async () => {
    view.getTools = () => [{ name: "ReadText", description: "Read an open editor." }];
    view.selectList.show();

    await view.selectList.showActions();

    expect(lumine.workspace.getModalTrail()).toEqual(["MCP Tools", "Actions"]);

    const spy = spyOn(view, "toggleMode");
    lumine.workspace.popModal();
    await view.selectList.runAction("lumine-mcp:toggle-mode");

    expect(spy).toHaveBeenCalled();
    expect(view.selectList.isVisible()).toBeTruthy();
  });
});
