class ToggleToolsView {
  constructor(getTools) {
    this.getTools = getTools;
    this.toolList = [];
    this.listMode = "blacklist";
    this.selectList = atom.workspace.buildSelectList({
      className: "lumine-mcp",
      crumb: "MCP Tools",
      emptyMessage: "No MCP tools found",
      helpMarkdown: this._helpMarkdown(),
      willShow: () => {
        this.toolList = atom.config.get("lumine-mcp.toolList") || [];
        this.listMode = atom.config.get("lumine-mcp.listMode") || "blacklist";
        this.selectList.update({ items: this.getTools(), helpMarkdown: this._helpMarkdown() });
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
      didConfirmSelection: (item) => {
        const index = this.selectList.selectionIndex;
        this.toggleTool(item.name);
        this.selectList.update({ items: this.getTools() });
        this.selectList.selectIndex(index);
      },
      didCancelSelection: () => {
        this.selectList.hide();
      },
    });

    // Registered in the package's own namespace: the item-actions list (F12)
    // derives its rows — label, description, keybinding — from these
    // registrations and the keymap.
    this.commands = atom.commands.add(this.selectList.element, {
      "lumine-mcp:enable-all": {
        description: "Enable every tool at once, clearing the blacklist or filling the greenlist",
        didDispatch: () => this.enableAll(),
      },
      "lumine-mcp:disable-all": {
        description: "Disable every tool at once, filling the blacklist or clearing the greenlist",
        didDispatch: () => this.disableAll(),
      },
      "lumine-mcp:reset-defaults": {
        description: "Restore the tool list and list mode shipped as package defaults",
        didDispatch: () => this.resetDefaults(),
      },
      "lumine-mcp:toggle-mode": {
        description: "Reinterpret the tool list as a blacklist or a greenlist",
        didDispatch: () => this.toggleMode(),
      },
    });
  }

  _helpMarkdown() {
    const modeLabel = this.listMode === "greenlist" ? "Greenlist" : "Blacklist";
    return (
      `Mode: **${modeLabel}**\n\n` +
      "The actions list (F12) shows every command with its keybinding."
    );
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
    atom.config.set("lumine-mcp.toolList", this.toolList);
  }

  toggleMode() {
    this.listMode = this.listMode === "blacklist" ? "greenlist" : "blacklist";
    atom.config.set("lumine-mcp.listMode", this.listMode);
    const index = this.selectList.selectionIndex;
    this.selectList.update({ items: this.getTools(), helpMarkdown: this._helpMarkdown() });
    this.selectList.selectIndex(index);
  }

  enableAll() {
    // blacklist: clear list (nothing blocked)
    // greenlist: fill list (everything allowed)
    this.toolList = this.listMode === "greenlist" ? this.getTools().map((t) => t.name) : [];
    atom.config.set("lumine-mcp.toolList", this.toolList);
    const index = this.selectList.selectionIndex;
    this.selectList.update({ items: this.getTools() });
    this.selectList.selectIndex(index);
  }

  disableAll() {
    // blacklist: fill list (everything blocked)
    // greenlist: clear list (nothing allowed)
    this.toolList = this.listMode === "blacklist" ? this.getTools().map((t) => t.name) : [];
    atom.config.set("lumine-mcp.toolList", this.toolList);
    const index = this.selectList.selectionIndex;
    this.selectList.update({ items: this.getTools() });
    this.selectList.selectIndex(index);
  }

  resetDefaults() {
    const listSchema = atom.config.getSchema("lumine-mcp.toolList");
    const modeSchema = atom.config.getSchema("lumine-mcp.listMode");
    this.toolList = listSchema?.default ? [...listSchema.default] : [];
    this.listMode = modeSchema?.default || "blacklist";
    atom.config.set("lumine-mcp.toolList", this.toolList);
    atom.config.set("lumine-mcp.listMode", this.listMode);
    const index = this.selectList.selectionIndex;
    this.selectList.update({ items: this.getTools(), helpMarkdown: this._helpMarkdown() });
    this.selectList.selectIndex(index);
  }

  destroy() {
    this.commands.dispose();
    this.selectList.destroy();
  }
}

module.exports = ToggleToolsView;
