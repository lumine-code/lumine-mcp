class ToggleToolsView {
  constructor(getTools) {
    this.getTools = getTools;
    this.toolList = [];
    this.listMode = "blacklist";
    this.selectList = lumine.workspace.buildSelectList({
      className: "lumine-mcp",
      crumb: "MCP Tools",
      emptyMessage: "No MCP tools found",
      infoMessage: this._infoLine(),
      confirmAction: "lumine-mcp:toggle-selected-tool",
      idForItem: (item) => item.name,
      willShow: () => {
        this.toolList = lumine.config.get("lumine-mcp.toolList") || [];
        this.listMode = lumine.config.get("lumine-mcp.listMode") || "blacklist";
        this.selectList.update({ items: this.getTools(), infoMessage: this._infoLine() });
      },
      filterKeyForItem: (item) => item.name + " " + item.description,
      elementForItem: (item, { highlight }) => {
        const inList = this.toolList.includes(item.name);
        const isEnabled = this.listMode === "greenlist" ? inList : !inList;
        const li = document.createElement("li");
        const primary = document.createElement("div");
        primary.classList.add("primary-line");
        const icon = document.createElement("span");
        icon.classList.add("icon", isEnabled ? "icon-check" : "icon-circle-slash");
        primary.appendChild(icon);
        const tag = document.createElement("span");
        tag.classList.add("tag");
        tag.appendChild(highlight(item.name));
        primary.appendChild(tag);
        if (item.description) {
          primary.appendChild(document.createTextNode(item.description));
        }
        li.appendChild(primary);
        return li;
      },
      didConfirmSelection: (item) => this.toggleSelectedTool(item),
      didCancelSelection: () => {
        this.selectList.hide();
      },
    });

    // Registered in the package's own namespace: the item-actions list
    // derives its rows — label, description, keybinding — from these
    // registrations and the keymap.
    this.commands = lumine.commands.add(this.selectList.element, {
      "lumine-mcp:toggle-selected-tool": {
        description: "Enable or disable the selected tool, keeping the list open.",
        didDispatch: () => this.toggleSelectedTool(),
      },
      "lumine-mcp:enable-all": {
        description: "Enable every tool at once, clearing the blacklist or filling the greenlist.",
        actionScope: "list",
        didDispatch: () => this.enableAll(),
      },
      "lumine-mcp:disable-all": {
        description: "Disable every tool at once, filling the blacklist or clearing the greenlist.",
        actionScope: "list",
        didDispatch: () => this.disableAll(),
      },
      "lumine-mcp:reset-defaults": {
        description: "Restore the tool list and list mode shipped as package defaults.",
        actionScope: "list",
        didDispatch: () => this.resetDefaults(),
      },
      "lumine-mcp:toggle-mode": {
        description: "Decide whether a tool arriving later is on or off by default.",
        actionScope: "list",
        didDispatch: () => this.toggleMode(),
      },
    });
  }

  // The mode is live state the rows depend on — the one line only this can say.
  _infoLine() {
    return `Mode: ${this.listMode === "greenlist" ? "Greenlist" : "Blacklist"}`;
  }

  toggle() {
    this.selectList.toggle();
  }

  toggleTool(name) {
    const index = this.toolList.indexOf(name);
    if (index === -1) {
      this.toolList.push(name);
    } else {
      this.toolList.splice(index, 1);
    }
    lumine.config.set("lumine-mcp.toolList", this.toolList);
  }

  toggleSelectedTool(item = null) {
    item ??= this.selectList.getSelectedItem();
    if (!item) {
      return;
    }

    const index = this.selectList.selectionIndex;
    this.toggleTool(item.name);
    this.selectList.update({ items: this.getTools() });
    this.selectList.selectIndex(index);
  }

  // The list is inverted along with the mode, so the same tools stay on.
  //
  // Taking the list at face value across the switch turned every enabled tool
  // off and every disabled one on — on the shipped defaults, that left exactly
  // CloseFile and RemoveProjectPath enabled and nothing else. What the mode is
  // actually for is what happens to a tool nobody has ruled on: under a
  // blacklist a newly registered tool arrives on, under a greenlist it arrives
  // off, and that is the choice this makes.
  toggleMode() {
    const names = this.getTools().map((tool) => tool.name);
    this.toolList = names.filter((name) => !this.toolList.includes(name));
    this.listMode = this.listMode === "blacklist" ? "greenlist" : "blacklist";
    lumine.config.set("lumine-mcp.toolList", this.toolList);
    lumine.config.set("lumine-mcp.listMode", this.listMode);
    const index = this.selectList.selectionIndex;
    this.selectList.update({ items: this.getTools(), infoMessage: this._infoLine() });
    this.selectList.selectIndex(index);
  }

  enableAll() {
    // blacklist: clear list (nothing blocked)
    // greenlist: fill list (everything allowed)
    this.toolList = this.listMode === "greenlist" ? this.getTools().map((t) => t.name) : [];
    lumine.config.set("lumine-mcp.toolList", this.toolList);
    const index = this.selectList.selectionIndex;
    this.selectList.update({ items: this.getTools() });
    this.selectList.selectIndex(index);
  }

  disableAll() {
    // blacklist: fill list (everything blocked)
    // greenlist: clear list (nothing allowed)
    this.toolList = this.listMode === "blacklist" ? this.getTools().map((t) => t.name) : [];
    lumine.config.set("lumine-mcp.toolList", this.toolList);
    const index = this.selectList.selectionIndex;
    this.selectList.update({ items: this.getTools() });
    this.selectList.selectIndex(index);
  }

  resetDefaults() {
    const listSchema = lumine.config.getSchema("lumine-mcp.toolList");
    const modeSchema = lumine.config.getSchema("lumine-mcp.listMode");
    this.toolList = listSchema?.default ? [...listSchema.default] : [];
    this.listMode = modeSchema?.default || "blacklist";
    lumine.config.set("lumine-mcp.toolList", this.toolList);
    lumine.config.set("lumine-mcp.listMode", this.listMode);
    const index = this.selectList.selectionIndex;
    this.selectList.update({ items: this.getTools(), infoMessage: this._infoLine() });
    this.selectList.selectIndex(index);
  }

  destroy() {
    this.commands.dispose();
    this.selectList.destroy();
  }
}

module.exports = ToggleToolsView;
