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
    view.selectList.update({ items: [tool] });
    const actions = view.selectList.itemActions();
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
    expect(toggleSelected.keystrokes).toEqual(["enter"]);
    expect(toggleSelected.scope).toBe("item");

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
      expect(byCommand.get(command).scope).toBe("list");
    }
    expect(view.selectList.getIdForItem(tool)).toBe(tool.name);

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
    view.selectList.update({ items: [] });

    expect(
      view.selectList
        .itemActions()
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

    await view.selectList.showItemActions();

    expect(view.selectList.itemActionsList.isVisible()).toBeTruthy();
    expect(lumine.workspace.getModalTrail()).toEqual(["MCP Tools", "Actions"]);
    // The actions list wears the package class, so the package keymap
    // resolves action keystrokes inside it too.
    expect(view.selectList.itemActionsList.element.classList.contains("lumine-mcp")).toBe(true);

    const spy = spyOn(view, "toggleMode");
    const index = view.selectList.itemActionsList.items.findIndex(
      (item) => item.command === "lumine-mcp:toggle-mode",
    );
    view.selectList.itemActionsList.selectIndex(index);
    view.selectList.itemActionsList.confirmSelection();

    expect(spy).toHaveBeenCalled();
    expect(view.selectList.isVisible()).toBeTruthy();
    expect(view.selectList.itemActionsList.isVisible()).toBeFalsy();
  });
});
