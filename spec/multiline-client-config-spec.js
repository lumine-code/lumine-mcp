const fs = require("fs");
const path = require("path");

// Full-suite replay also blocks launchers used by independently loaded peers.
jasmine.getEnv().allowRespy(true);
beforeEach(() => {
  for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
    spyOn(lumine.shell, method).and.resolveTo();
  spyOn(lumine.application, "openWindow").and.resolveTo();
});

describe("MCP client registration with a multiline TOML array", () => {
  let main, registrar, root, configPath, temporary, serverPath, invalidSnapshots;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    lumine.config.set("lumine-mcp.autoStart", false);
    await lumine.packages.activatePackage("language-toml");
    main = (await lumine.packages.activatePackage("lumine-mcp")).mainModule;
    root = fs.mkdtempSync(path.join(process.env.TMPDIR, "mcp-toml-native-"));
    const home = path.join(root, "codex");
    temporary = path.join(root, "temporary");
    fs.mkdirSync(home);
    fs.mkdirSync(temporary);
    configPath = path.join(home, "config.toml");
    serverPath = main.provideMcpBridge().getServerPath();
    invalidSnapshots = [];
    const Registrar = main.clientRegistrar.constructor;
    registrar = main._clientRegistrar = new Registrar({
      environment: { CODEX_HOME: home },
      homeDirectory: root,
      temporaryDirectory: temporary,
      activeDirectory: () => root,
      serverPath,
      confirm: jasmine.createSpy("private confirmation").and.resolveTo(1),
      notify: {
        error: jasmine.createSpy("registration error"),
        success: jasmine.createSpy("registration success"),
        warning: jasmine.createSpy("registration warning"),
      },
      // The CLI boundary reads only this owned file. Real Core's TOML parser
      // validates every read; no user CLI, client config, or bridge is started.
      run: async (command, args) => {
        if (command === "node") return { code: 0, stdout: process.version, stderr: "" };
        if (command !== "codex" || args.join(" ") !== "mcp get lumine --json")
          throw new Error(`Unexpected client operation: ${command} ${args.join(" ")}`);
        const contents = fs.readFileSync(configPath, "utf8");
        const editor = await lumine.workspace.open(configPath);
        try {
          await editor.getBuffer().getLanguageMode().ready;
          expect(editor.getGrammar().scopeName).toBe("source.toml");
          if (editor.getBuffer().getLanguageMode().tree.rootNode.hasError) {
            invalidSnapshots.push(contents);
            return { code: 1, stdout: "", stderr: "Invalid TOML configuration" };
          }
          const variables = contents.match(/env_vars\s*=\s*\[([^\]]*)\]/)?.[1] ?? "";
          const envVars = [...variables.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              name: "lumine",
              transport: { type: "stdio", command: "node", args: [serverPath], env_vars: envVars },
              tool_timeout_sec: Number(contents.match(/tool_timeout_sec\s*=\s*(\d+)/)?.[1]) || null,
            }),
          };
        } finally {
          editor.destroy();
          await lumine.fileWatchClient.settlePendingTeardown();
        }
      },
    });
  });

  afterEach(async () => {
    if (lumine.packages.isPackageActive("lumine-mcp"))
      await lumine.packages.deactivatePackage("lumine-mcp");
    if (lumine.packages.isPackageLoaded("lumine-mcp"))
      await lumine.packages.unloadPackage("lumine-mcp");
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync(process.env.TMPDIR), fs.realpathSync(root));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Owned config cleanup escaped the private temporary directory");
    fs.unlinkSync(configPath);
    fs.rmdirSync(path.dirname(configPath));
    fs.rmdirSync(temporary);
    fs.rmdirSync(root);
    main = registrar = root = configPath = temporary = serverPath = invalidSnapshots = null;
  });

  async function registerWithArray(array) {
    const prefix = 'theme = "dark"\n\n[mcp_servers.lumine]\n';
    const suffix = '\n[projects.example]\ntrust_level = "trusted"\n';
    fs.writeFileSync(
      configPath,
      prefix +
        `command = "node"\nargs = [${JSON.stringify(serverPath)}]\nenv_vars = ${array}` +
        suffix,
    );
    spyOn(registrar, "register").and.callThrough();
    lumine.commands.dispatch(lumine.workspace.getElement(), "lumine-mcp:register-to-codex");
    expect(registrar.register).toHaveBeenCalledTimes(1);
    const result = await registrar.register.calls.mostRecent().returnValue;
    expect(invalidSnapshots).toEqual([]);
    expect(result).toBe(true);
    expect(registrar.notify.error).not.toHaveBeenCalled();
    const current = fs.readFileSync(configPath, "utf8");
    expect(current.startsWith(prefix)).toBe(true);
    expect(current.endsWith(suffix)).toBe(true);
    expect(current).toContain('env_vars = ["EXISTING", "LUMINE_BRIDGE_PORT"]');
    expect(current).toContain("tool_timeout_sec = 75");
    expect(registrar.confirm).not.toHaveBeenCalled();
  }

  it("updates a valid multiline array without leaving invalid continuation text", async () => {
    await registerWithArray('[\n  "EXISTING", # a closing ] in a comment\n]');
  });

  it("preserves the ordinary single-line array and unrelated sections", async () => {
    await registerWithArray('["EXISTING"]');
  });
});
