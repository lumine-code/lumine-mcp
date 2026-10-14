const { Emitter } = require("lumine");

const emitter = new Emitter();
let tools = new Map();

exports.getExternalTools = () => tools;
exports.onDidChangeExternalTools = (callback) => emitter.on("did-change", callback);
exports.setExternalTools = (nextTools) => {
  tools = nextTools;
  emitter.emit("did-change", tools);
};
