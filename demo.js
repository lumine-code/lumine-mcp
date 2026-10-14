// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["language-javascript"],
  viewport: { width: 1100, height: 730 },
  async before(context) {
    const { lumine } = context;
    lumine.config.set("lumine-mcp.autoStart", false);
  },
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("workflows/signal.js");
    await lumine.project.setPaths([fixture("workflows")]);
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Choose the editor tools exposed through the MCP integration.",
      timeout: 60000,
      async run(context) {
        const { lumine, state } = context;
        {
          lumine.commands.dispatch(lumine.views.getView(state.editor), "lumine-mcp:toggle-tools");
        }
      },
      ready() {
        return Boolean(document.querySelector(".lumine-mcp")?.getBoundingClientRect().height > 50);
      },
    },
  ],
  async cleanup() {},
};
