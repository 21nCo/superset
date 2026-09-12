import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type {
  McpFnTarget,
  McpFnTargetContext,
  McpFnTargetDescriptor,
  McpFnTransportHandle,
} from "./types.js";

export interface McpFnStdioTargetOptions extends Omit<StdioServerParameters, "command"> {
  command: string;
}

export interface McpFnStreamableHttpTargetOptions
  extends Omit<StreamableHTTPClientTransportOptions, "authProvider"> {
  authProvider?: OAuthClientProvider;
}

interface StateValidatingOAuthProvider extends OAuthClientProvider {
  validateAuthorizationState?(state: string | undefined): void | Promise<void>;
  invalidatePendingAuthorization?(): void | Promise<void>;
}

export function customTarget(options: {
  kind: string;
  descriptor?: Record<string, unknown>;
  open(context: McpFnTargetContext): Promise<McpFnTransportHandle> | McpFnTransportHandle;
  cleanup?(): Promise<void>;
}): McpFnTarget {
  const descriptor = Object.freeze({ kind: options.kind, ...options.descriptor });
  return {
    kind: options.kind,
    describe: () => ({ ...descriptor }),
    open: (context) => Promise.resolve(options.open(context)),
    ...(options.cleanup ? { cleanup: () => options.cleanup!() } : {}),
  };
}

export function transportTarget(
  transport: Transport,
  descriptor?: McpFnTargetDescriptor,
): McpFnTarget {
  const targetDescriptor = descriptor ?? { kind: "custom" };
  let opened = false;
  return customTarget({
    kind: targetDescriptor.kind,
    descriptor: targetDescriptor,
    open: () => {
      if (opened) throw new Error("A one-shot McpFn transport target cannot be reopened");
      opened = true;
      return { transport, close: () => transport.close() };
    },
  });
}

export function stdioTarget(options: McpFnStdioTargetOptions): McpFnTarget {
  if (!options.command.trim()) throw new Error("McpFn stdio target command is required");
  return customTarget({
    kind: "stdio",
    descriptor: {
      command: options.command,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    },
    open: () => {
      const transport = new StdioClientTransport(options);
      return {
        transport,
        close: () => transport.close(),
      };
    },
  });
}

export function streamableHttpTarget(
  url: string | URL,
  options: McpFnStreamableHttpTargetOptions = {},
): McpFnTarget {
  const targetUrl = new URL(url.toString());
  const descriptorUrl = new URL(targetUrl.toString());
  descriptorUrl.search = "";
  descriptorUrl.hash = "";
  descriptorUrl.username = "";
  descriptorUrl.password = "";
  return customTarget({
    kind: "streamable-http",
    descriptor: { url: descriptorUrl.toString() },
    open: () => {
      const transport = new StreamableHTTPClientTransport(targetUrl, options);
      return {
        transport,
        finishAuthorization: async (authorizationCode, state) => {
          const provider = options.authProvider as StateValidatingOAuthProvider | undefined;
          try {
            await provider?.validateAuthorizationState?.(state);
            await transport.finishAuth(authorizationCode);
          } catch (error) {
            await provider?.invalidatePendingAuthorization?.();
            throw error;
          }
        },
        terminateSession: () => transport.terminateSession(),
        close: () => transport.close(),
      };
    },
  });
}
