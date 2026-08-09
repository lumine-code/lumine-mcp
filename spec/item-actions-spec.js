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
    const actions = view.selectList.itemActions();
    const byCommand = new Map(actions.map((action) => [action.command, action]));

    expect([...byCommand.keys()].sort()).toEqual([
      "lumine-mcp:disable-all",
      "lumine-mcp:enable-all",
      "lumine-mcp:reset-defaults",
      "lumine-mcp:toggle-mode",
    ]);

    const toggleMode = byCommand.get("lumine-mcp:toggle-mode");
    expect(toggleMode.name).toBe("Toggle Mode");
    expect(toggleMode.description).toBe("Reinterpret the tool list as a blacklist or a greenlist");
    expect(toggleMode.keystrokes).toEqual(["alt-enter"]);
    expect(byCommand.get("lumine-mcp:enable-all").keystrokes).toEqual(["alt-="]);
    expect(byCommand.get("lumine-mcp:disable-all").keystrokes).toEqual(["alt--"]);
    expect(byCommand.get("lumine-mcp:reset-defaults").keystrokes).toEqual(["alt-0"]);

    // Every action explains itself with more than a restated title.
    for (const action of actions) {
      expect(action.description).toBeTruthy();
    }

    // Chrome and global commands stay out.
    expect(byCommand.has("core:confirm")).toBe(false);
    expect(byCommand.has("select-list:actions")).toBe(false);
    expect(byCommand.has("lumine-mcp:toggle-tools")).toBe(false);
  });

  it("shows the actions as a flow step and runs one against the master list", async () => {
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
