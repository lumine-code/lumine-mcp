describe("MCP bridge lifecycle command availability", () => {
  let main;
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    lumine.config.set("lumine-mcp.autoStart", false);
    main = (await lumine.packages.activatePackage("lumine-mcp")).mainModule;
  });
  afterEach(() => {
    main.bridge = null;
    main.startPromise = null;
  });
  it("uses cached bridge and pending start state without starting the service", () => {
    const target = lumine.workspace.getElement(),
      has = (id) => lumine.commands.canDispatch(target, "lumine-mcp:" + id);
    const start = spyOn(main, "startBridge").and.throwError("query started bridge");
    expect(has("start")).toBe(true);
    expect(has("stop")).toBe(false);
    main.startPromise = Promise.resolve();
    expect(has("start")).toBe(false);
    expect(has("stop")).toBe(true);
    main.startPromise = null;
    main.bridge = { port: 3000 };
    expect(has("start")).toBe(false);
    expect(has("stop")).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });
});
