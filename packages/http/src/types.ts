/**
 * Core type definitions for the HTTP abstraction layer
 */

export type CookieSameSite = 'lax' | 'strict' | 'none';

export const AUTH_ROUTE_MODES = ['none', 'cookie-session', 'bearer', 'hybrid'] as const;
export type AuthRouteMode = (typeof AUTH_ROUTE_MODES)[number];

export interface AuthRouteMeta {
  mode: AuthRouteMode;
  csrf?: boolean;
  scopes?: string[];
  [key: string]: unknown;
}

export interface OpenApiRouteMeta {
  include?: boolean;
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  requestBodySchema?: Record<string, unknown>;
  responseSchemas?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export interface HttpRouteMeta {
  auth?: AuthRouteMeta;
  openapi?: OpenApiRouteMeta;
  [key: string]: unknown;
}

export interface SetCookieInput {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: CookieSameSite;
  maxAge?: number;
  expires?: Date;
}

// ============================================================================
// Client Transport Auth
// ============================================================================

export type HttpTransportAuthRetryDecision = 'retry' | 'fail' | void;

export interface HttpTransportErrorEvent {
  endpoint: string;
  url: string;
  status: number;
  result: unknown;
}

/**
 * Supplies authentication material for fetch-based Superfunctions transports.
 */
export interface HttpTransportAuthProvider {
  getRequestHeaders?(): HeadersInit | null | undefined | Promise<HeadersInit | null | undefined>;
  getCredentials?(): RequestCredentials | undefined | Promise<RequestCredentials | undefined>;
  onUnauthorized?(
    event: HttpTransportErrorEvent,
  ): HttpTransportAuthRetryDecision | Promise<HttpTransportAuthRetryDecision>;
}

/**
 * Adds auth-related request material to a transport auth provider without owning the base session.
 */
export interface HttpTransportAuthPlugin {
  getRequestHeaders?(): HeadersInit | null | undefined | Promise<HeadersInit | null | undefined>;
}

/**
 * Configures a transport auth provider implementation.
 */
export interface HttpTransportAuthOptions {
  credentials?: RequestCredentials;
  headers?: HeadersInit | (() => HeadersInit | null | undefined | Promise<HeadersInit | null | undefined>);
  plugins?: HttpTransportAuthPlugin[];
  onUnauthorized?(
    event: HttpTransportErrorEvent,
  ): HttpTransportAuthRetryDecision | Promise<HttpTransportAuthRetryDecision>;
}

// ============================================================================
// Router Configuration
// ============================================================================

export interface RouterOptions<TContext = any> {
  /** Route definitions */
  routes: Route<TContext>[];

  /** Global middleware (runs before all routes) */
  middleware?: Middleware<TContext>[];

  /** Context factory (creates context per request) */
  context?: TContext | ((request: Request) => Promise<TContext> | TContext);

  /** Error handler */
  onError?: (error: Error, request: Request) => Response | Promise<Response>;

  /** Base path for all routes */
  basePath?: string;

  /** CORS configuration */
  cors?: CorsOptions | false;

  /**
   * Maximum request body size in bytes accepted by `ctx.json()`/`ctx.text()`/
   * `ctx.formData()`. Bodies exceeding this (by Content-Length or by streamed
   * size) are rejected with a 413 PayloadTooLargeError. Unset means no limit.
   */
  maxBodyBytes?: number;
}

// ============================================================================
// Route Definition
// ============================================================================

export interface Route<TContext = any> {
  /** HTTP method */
  method: HttpMethod;

  /** Route path (supports params: /users/:id) */
  path: string;

  /** Decode path parameters before dispatch (default true). Disable only when the handler validates raw segments. */
  decodeParams?: boolean;

  /** Route handler */
  handler: RouteHandler<TContext>;

  /** Route-specific middleware */
  middleware?: Middleware<TContext>[];

  /** Metadata (for docs, validation, etc.) */
  meta?: HttpRouteMeta;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';

export type RouteHandler<TContext = any> = (
  request: Request,
  context: TContext & RouteContext
) => Promise<Response> | Response;

// ============================================================================
// Route Context
// ============================================================================

export interface RouteContext {
  /** Parsed path params */
  params: Record<string, string>;

  /** Query string parsed as URLSearchParams */
  query: URLSearchParams;

  /** Request URL */
  url: URL;

  /** Convenience: parse JSON body */
  json: <T = any>() => Promise<T>;

  /** Convenience: parse form data */
  formData: () => Promise<FormData>;

  /** Convenience: get text body */
  text: () => Promise<string>;
}

// ============================================================================
// Middleware
// ============================================================================

export type Middleware<TContext = any> = (
  request: Request,
  context: TContext & RouteContext,
  next: () => Promise<Response>
) => Promise<Response> | Response;

// ============================================================================
// Router Interface
// ============================================================================

export interface Router<TContext = any> {
  /** Handle a Web Standard Request */
  handle(request: Request): Promise<Response>;

  /** Get all routes */
  getRoutes(): Route<TContext>[];

  /** Add route dynamically */
  addRoute(route: Route<TContext>): void;

  /** Add middleware dynamically */
  use(middleware: Middleware<TContext>): void;

  /** Match route by method and path */
  match(method: string, path: string): MatchedRoute<TContext> | null;

  /**
   * Universal handler - can be used directly in Fetch-native frameworks
   * This is an alias to router.handle for convenience
   */
  handler: (request: Request) => Promise<Response>;
}

export interface MatchedRoute<TContext = any> {
  route: Route<TContext>;
  params: Record<string, string>;
}

// ============================================================================
// CORS Configuration
// ============================================================================

export interface CorsOptions {
  /** Allowed origins (string, array, or function) */
  origin?: string | string[] | ((origin: string) => boolean);

  /** Allowed methods */
  methods?: HttpMethod[];

  /** Allowed headers */
  allowedHeaders?: string[];

  /** Exposed headers */
  exposedHeaders?: string[];

  /** Allow credentials */
  credentials?: boolean;

  /** Max age for preflight cache */
  maxAge?: number;
}

// ============================================================================
// Internal Types
// ============================================================================

export interface CompiledRoute<TContext = any> {
  route: Route<TContext>;
  pattern: RegExp;
  keys: string[];
}
