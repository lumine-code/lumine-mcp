// The MCP tool blacklist/greenlist editor.
//
// Config is the only state this view has: every verb writes it and asks the
// kernel to re-run the source, which is what redraws each row's enabled glyph.

const VIEW_ID = "lumine-mcp.tools";

// Stay open and redraw from config. Reopening the list after every single
// toggle is exactly what this view exists to avoid.
const AGAIN = Object.freeze({ keepOpen: true, refresh: true });

// A copy: `atom.config.get` hands back the stored array itself, so mutating it
// in place would leave the following `set` with no change to notice.
function getToolList() {
  return [...(atom.config.get("lumine-mcp.toolList") || [])];
}

function getListMode() {
  return atom.config.get("lumine-mcp.listMode") || "blacklist";
}

function helpMarkdown() {
  const modeLabel = getListMode() === "greenlist" ? "Greenlist" : "Blacklist";
  return (
    `Mode: **${modeLabel}**\n\n` +
    "Commands:\n" +
    "- **Enter**: Toggle tool in list\n" +
    "- **Alt+Enter**: Switch blacklist/greenlist mode\n" +
    "- **Alt+=**: Enable all tools\n" +
    "- **Alt+-**: Disable all tools\n" +
    "- **Alt+0**: Reset to defaults"
  );
}

function toggleTool(name) {
  const list = getToolList();
  const index = list.indexOf(name);
  if (index === -1) {
    list.push(name);
  } else {
    list.splice(index, 1);
  }
  atom.config.set("lumine-mcp.toolList", list);
}

// Every tool the source produced, whether or not the query hides it: the
// all-on/all-off verbs never operated on the filtered subset.
function allToolNames(session) {
  return session.getItems().map((tool) => tool.name);
}

// The mode is the first line of the help text, so a mode change has to re-seat
// it or an open help panel keeps naming the mode we just left.
function refreshHelp(session) {
  session.setHelp(helpMarkdown);
}

function toggleTools(getTools) {
  return atom.modals.toggle({
    id: VIEW_ID,
    className: "lumine-mcp",
    emptyMessage: "No MCP tools found",
    help: helpMarkdown,
    // Membership in the list means "enabled" under a greenlist and "disabled"
    // under a blacklist, so the flag is resolved per run rather than per row.
    source: () => {
      const list = getToolList();
      const greenlist = getListMode() === "greenlist";
      return getTools().map((tool) => ({
        ...tool,
        enabled: greenlist ? list.includes(tool.name) : !list.includes(tool.name),
      }));
    },
    renderer: {
      entry: (tool) => ({ id: tool.name, text: `${tool.name} ${tool.description || ""}` }),
      row: (tool) => ({
        icon: [tool.enabled ? "icon-check" : "icon-circle-slash"],
        label: tool.name,
        description: tool.description || undefined,
      }),
    },
    actions: [
      {
        name: "confirm",
        label: "Toggle tool in list",
        when: "item",
        run: ({ item }) => {
          toggleTool(item.name);
          return AGAIN;
        },
      },
      {
        name: "toggle-mode",
        label: "Switch blacklist/greenlist mode",
        keystroke: "alt-enter",
        when: "always",
        run: ({ session }) => {
          atom.config.set(
            "lumine-mcp.listMode",
            getListMode() === "blacklist" ? "greenlist" : "blacklist",
          );
          refreshHelp(session);
          return AGAIN;
        },
      },
      {
        name: "enable-all",
        label: "Enable all tools",
        keystroke: "alt-=",
        when: "always",
        run: ({ session }) => {
          // blacklist: clear list (nothing blocked)
          // greenlist: fill list (everything allowed)
          const names = getListMode() === "greenlist" ? allToolNames(session) : [];
          atom.config.set("lumine-mcp.toolList", names);
          return AGAIN;
        },
      },
      {
        name: "disable-all",
        label: "Disable all tools",
        keystroke: "alt--",
        when: "always",
        run: ({ session }) => {
          // blacklist: fill list (everything blocked)
          // greenlist: clear list (nothing allowed)
          const names = getListMode() === "blacklist" ? allToolNames(session) : [];
          atom.config.set("lumine-mcp.toolList", names);
          return AGAIN;
        },
      },
      {
        name: "reset-defaults",
        label: "Reset to defaults",
        keystroke: "alt-0",
        when: "always",
        run: ({ session }) => {
          const listSchema = atom.config.getSchema("lumine-mcp.toolList");
          const modeSchema = atom.config.getSchema("lumine-mcp.listMode");
          atom.config.set(
            "lumine-mcp.toolList",
            listSchema?.default ? [...listSchema.default] : [],
          );
          atom.config.set("lumine-mcp.listMode", modeSchema?.default || "blacklist");
          refreshHelp(session);
          return AGAIN;
        },
      },
    ],
    // Nothing focused means nothing to toggle: the list used to sit there
    // rather than close, and Enter on an empty result still should.
    confirmEmpty: () => ({ keepOpen: true }),
  });
}

// Closes the tool list, but only if it is what is currently up.
function hideTools() {
  const session = atom.modals.getActiveSession();
  if (session && session.rootSpec.id === VIEW_ID) session.cancel("api");
}

module.exports = { VIEW_ID, toggleTools, hideTools };
