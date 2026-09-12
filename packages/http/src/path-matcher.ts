/**
 * Path matching and parameter extraction for routes
 */

export interface PathMatch {
  matched: boolean;
  params: Record<string, string>;
}

export interface CompiledPattern {
  pattern: RegExp;
  keys: string[];
}

/**
 * Convert Express-style path pattern to regex with named capture groups
 * Examples:
 * - /users/:id -> /users/(?<id>[^/]+)
 * - /posts/:id/comments/:commentId -> /posts/(?<id>[^/]+)/comments/(?<commentId>[^/]+)
 */
export function compilePattern(pattern: string): CompiledPattern {
  const keys: string[] = [];
  
  // Escape special regex characters except :
  let regexPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  
  // Replace :param with named capture groups
  regexPattern = regexPattern.replace(/:(\w+)/g, (_, key) => {
    keys.push(key);
    return `(?<${key}>[^/]+)`;
  });
  
  // Add start and end anchors
  const regex = new RegExp(`^${regexPattern}$`);
  
  return { pattern: regex, keys };
}

/**
 * Match a path against a compiled pattern and extract parameters
 */
export function matchPath(compiledPattern: CompiledPattern, path: string, decodeParams = true): PathMatch {
  const match = path.match(compiledPattern.pattern);
  
  if (!match) {
    return { matched: false, params: {} };
  }
  
  const params: Record<string, string> = {};
  
  // Extract named groups
  if (match.groups) {
    for (const key of compiledPattern.keys) {
      params[key] = decodeParams ? decodeURIComponent(match.groups[key]) : match.groups[key];
    }
  }
  
  return { matched: true, params };
}

/**
 * Normalize path by removing trailing slashes and ensuring leading slash
 */
export function normalizePath(path: string): string {
  // Remove trailing slash (except for root path)
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  
  // Ensure leading slash
  if (!path.startsWith('/')) {
    path = '/' + path;
  }
  
  return path;
}

/**
 * Join base path with route path
 */
export function joinPaths(basePath: string, routePath: string): string {
  const normalizedBase = normalizePath(basePath);
  const normalizedRoute = normalizePath(routePath);
  
  if (normalizedBase === '/') {
    return normalizedRoute;
  }
  
  return normalizedBase + normalizedRoute;
}
