export default {
  formatVersion: 1,
  kind: "mcpfn.scenarios",
  status: "complete",
  scenarios: [
    {
      name: "external official-SDK server initializes",
      kind: "initialize",
      expectCapabilities: { tools: { listChanged: true } },
    },
    {
      name: "external official-SDK server accepts authenticated tool calls",
      kind: "tools.call",
      tool: "external_identity",
      expect: {
        structuredContent: { authenticated: true },
        structuredTextParity: true,
      },
    },
  ],
};
