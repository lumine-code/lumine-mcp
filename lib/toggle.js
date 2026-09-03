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
      getItemId: (item) => item.name,
      source: {
        mode: "snapshot",
        load: () => {
          this.toolList = lumine.config.get("lumine-mcp.toolList") || [];
          this.listMode = lumine.config.get("lumine-mcp.listMode") || "blacklist";
          return { items: this.getTools(), infoMessage: this._infoLine() };
        },
      },
      search: { getFilterText: (item) => item.name + " " + item.description },
      renderItem: (item, { highlight }) => {
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
      commands: {
        "lumine-mcp:toggle-selected-tool": {
          description: "Enable or disable the selected tool, keeping the list open.",
          didDispatch: (event) => this.toggleSelectedTool(event.detail.item),
        },
        "lumine-mcp:enable-all": {
          description:
            "Enable every tool at once, clearing the blacklist or filling the greenlist.",
          didDispatch: () => this.enableAll(),
        },
        "lumine-mcp:disable-all": {
          description:
            "Disable every tool at once, filling the blacklist or clearing the greenlist.",
          didDispatch: () => this.disableAll(),
        },
        "lumine-mcp:reset-defaults": {
          description: "Restore the tool list and list mode shipped as package defaults.",
          didDispatch: () => this.resetDefaults(),
        },
        "lumine-mcp:toggle-mode": {
          description: "Decide whether a tool arriving later is on or off by default.",
          didDispatch: () => this.toggleMode(),
        },
      },
      actions: [
        {
          command: "lumine-mcp:toggle-selected-tool",
          context: "item",
          primary: true,
          group: "Tool",
          disposition: "stay",
          dispatch: "local",
        },
        {
          command: "lumine-mcp:enable-all",
          context: "dialog",
          group: "All Tools",
          disposition: "stay",
          dispatch: "local",
        },
        {
          command: "lumine-mcp:disable-all",
          context: "dialog",
          group: "All Tools",
          tone: "danger",
          disposition: "stay",
          dispatch: "local",
        },
        {
          command: "lumine-mcp:reset-defaults",
          context: "dialog",
          group: "Configuration",
          disposition: "stay",
          dispatch: "local",
        },
        {
          command: "lumine-mcp:toggle-mode",
          context: "dialog",
          group: "Configuration",
          disposition: "stay",
          dispatch: "local",
        },
      ],
    });
  }

  // The mode is live state the rows depend on — the one line only this can say.
  _infoLine() {
    return `Mode: ${this.listMode === "greenlist" ? "Greenlist" : "Blacklist"}`;
  }

  toggle() {
    return this.selectList.toggle();
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

    this.toggleTool(item.name);
    return this.selectList.setItems(this.getTools());
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
    this.selectList.setInfoMessage(this._infoLine());
    return this.selectList.setItems(this.getTools());
  }

  enableAll() {
    // blacklist: clear list (nothing blocked)
    // greenlist: fill list (everything allowed)
    this.toolList = this.listMode === "greenlist" ? this.getTools().map((t) => t.name) : [];
    lumine.config.set("lumine-mcp.toolList", this.toolList);
    return this.selectList.setItems(this.getTools());
  }

  disableAll() {
    // blacklist: fill list (everything blocked)
    // greenlist: clear list (nothing allowed)
    this.toolList = this.listMode === "blacklist" ? this.getTools().map((t) => t.name) : [];
    lumine.config.set("lumine-mcp.toolList", this.toolList);
    return this.selectList.setItems(this.getTools());
  }

  resetDefaults() {
    const listSchema = lumine.config.getSchema("lumine-mcp.toolList");
    const modeSchema = lumine.config.getSchema("lumine-mcp.listMode");
    this.toolList = listSchema?.default ? [...listSchema.default] : [];
    this.listMode = modeSchema?.default || "blacklist";
    lumine.config.set("lumine-mcp.toolList", this.toolList);
    lumine.config.set("lumine-mcp.listMode", this.listMode);
    this.selectList.setInfoMessage(this._infoLine());
    return this.selectList.setItems(this.getTools());
  }

  destroy() {
    return this.selectList.destroy();
  }
}

module.exports = ToggleToolsView;
