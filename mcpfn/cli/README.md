# McpFn CLI

The `mcpfn` CLI provides stable CI exit behavior:

```sh
mcpfn manifest ./mcp-server.ts --output mcpfn.manifest.json
mcpfn validate mcpfn.manifest.json
mcpfn diff main.manifest.json mcpfn.manifest.json --fail-on-behavioral
mcpfn test ./mcp-server.ts ./mcp-scenarios.ts --output mcpfn-report.json
mcpfn test-target https://api.example.com/mcp ./mcp-scenarios.ts
mcpfn test-target https://api.example.com/mcp ./mcp-scenarios.ts --header 'Authorization: Bearer $MCP_TOKEN'
mcpfn inspect https://api.example.com/mcp --output inspection.json
mcpfn inspect node --stdio --args '["./dist/server.js"]'
mcpfn auth-diagnose https://api.example.com/mcp
mcpfn conformance http://127.0.0.1:3000/mcp --suite active --header 'X-API-Key: $MCP_TEST_KEY'
```

- `0`: valid, compatible, or all scenarios passed;
- `1`: breaking/selected behavioral change, test failure, or official conformance failure;
- `2`: invalid configuration, source, or command usage.

`inspect` and `test-target` use the production `@mcpfn/client` session engine;
HTTP is the default and `--stdio` treats the target as an executable.
`auth-diagnose` probes protected-resource and authorization-server discovery
without opening a browser or exchanging credentials. Reports and inspector
timelines are redacted, versioned, and aggregate-size bounded. Target open,
authorization, and execution failures use exit `1`; malformed command or file
configuration uses exit `2`. `mcpfn test --max-report-bytes` can tighten the
default one-MiB scenario report cap.

The conformance command delegates to the pinned official
`@modelcontextprotocol/conformance` package. It requires Node.js 22 or newer;
the other CLI commands support Node.js 18.18 or newer. McpFn does not maintain
a competing protocol test suite.

For protected HTTP targets, `inspect`, `test-target`, and `conformance` accept
repeatable `--header 'Name: Value'` options. Header values are injected into the
official SDK transport without being included in target descriptors or reports.
Authenticated conformance uses a fixed loopback proxy because the upstream
runner has no credential-provider option; its upstream must therefore be a
literal loopback address. Use an application-owned OAuth provider with the
`@mcpfn/client` transport contract when a token must be acquired or refreshed.

The manifest source may be JSON, a default-exported `McpFnServer`, an async factory returning a server, or a `McpFnRegistry`. Registry sources require both `--name` and `--version`. The `test` command requires a server export because it exercises a real client/server connection.

Scenario modules default-export either an array of `McpFnScenario` values or a
version 1 `mcpfn.scenarios` artifact. See the runnable [server](https://github.com/21nCo/super-functions/blob/main/mcpfn/examples/calculator-server.ts), [scenarios](https://github.com/21nCo/super-functions/blob/main/mcpfn/examples/calculator-scenarios.ts), and committed [manifest](https://github.com/21nCo/super-functions/blob/main/mcpfn/examples/calculator.manifest.json).
