# bot architecture

This monorepo contains bot implementations (Discord, Slack, Telegram, etc.) using a shared, platform-agnostic architecture.

## technology stack

- **Framework**: [Hono](https://hono.dev/) - lightweight, fast web framework
- **Validation**: [Zod](https://zod.dev/) - TypeScript-first schema validation
- **Monorepo**: [Turborepo](https://turbo.build/) - high-performance build system

## architecture principles

### multi-platform deployment

Each bot separates platform-specific code from core business logic, enabling deployment to multiple hosting providers.

**File structure**:
```
bots/[bot-name]/
├── src/
│   ├── core.ts              # Platform-agnostic business logic
│   ├── index.cloudflare.ts  # Cloudflare Workers entry point
│   ├── index.digitalocean.ts # DigitalOcean Functions entry point
│   └── index.vercel.ts      # Vercel Serverless entry point
├── package.json
└── tsconfig.json
```

### core logic separation

**`core.ts`** contains:
- Bot interaction handlers (Discord, Slack, etc.)
- Business logic (e.g., API integrations)
- Validation schemas (Zod)
- Utility functions
- All code that is platform-independent

**Platform-specific files** (`index.*.ts`) contain:
- Environment variable access patterns
- Platform-specific Hono app initialization
- Request/response adapters if needed
- Deployment configuration

## shared packages

### packages/discord-core
Discord-specific utilities:
- Discord signature verification
- Interaction type constants
- Response builders
- Crypto utilities for Ed25519 verification

**Note**: Platform-specific packages (like `discord-core`) are only dependencies for bots that need them. Create similar packages for other platforms (e.g., `slack-core`, `telegram-core`) as needed.

### packages/github-integration
GitHub API helpers:
- GitHub App authentication (JWT generation)
- GitHub API request wrapper
- Common GitHub operations

### packages/shared-types
Shared TypeScript types and Zod schemas:
- Common bot interaction types
- API response types
- Validation schemas for commands and options

## creating a new bot

1. Create directory structure:
```bash
mkdir -p bots/my-bot/src
cd bots/my-bot
```

2. Initialize package.json:
```json
{
  "name": "@botfn/my-bot",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev src/index.cloudflare.ts",
    "deploy:cloudflare": "wrangler deploy src/index.cloudflare.ts",
    "deploy:vercel": "vercel",
    "build": "tsc"
  },
  "dependencies": {
    "hono": "^4.0.0",
    "zod": "^3.22.0",
    "@botfn/discord-core": "workspace:*",
    "@botfn/shared-types": "workspace:*"
  }
}
```

3. Create `src/core.ts` with business logic:
```typescript
import { Hono } from 'hono';
import { z } from 'zod';
// Import platform-specific utilities as needed
// import { verifyDiscordRequest } from '@botfn/discord-core';
// import { verifySlackRequest } from '@botfn/slack-core';

// Define schemas
const CommandOptionsSchema = z.object({
  // your command options
});

// Define handlers
export function createBotHandlers(env: any) {
  return {
    async handleCommand(interaction: any) {
      // Business logic here
    }
  };
}

// Export core app factory
export function createBotApp() {
  const app = new Hono();
  
  app.post('/interactions', async (c) => {
    const env = c.env;
    const handlers = createBotHandlers(env);
    
    // Handle bot interactions
    // ...
    
    return c.json({ type: 1 }); // Response format depends on platform
  });
  
  return app;
}
```

4. Create platform-specific entry points:

**`src/index.cloudflare.ts`**:
```typescript
import { createBotApp } from './core';

const app = createBotApp();

export default app;
```

**`src/index.digitalocean.ts`**:
```typescript
import { createBotApp } from './core';

const app = createBotApp();

// DigitalOcean Functions use Node.js runtime
// Export the handler for the serverless function
export const main = app.fetch;
```

**`src/index.vercel.ts`**:
```typescript
import { handle } from '@hono/vercel';
import { createBotApp } from './core';

const app = createBotApp();

export default handle(app);
```

## validation with Zod

Always validate bot interaction data and external inputs:

```typescript
import { z } from 'zod';

const LinkCommandSchema = z.object({
  repository: z.string().min(1),
  search: z.string().min(1),
});

// In handler
const options = interaction.data.options;
const parsed = LinkCommandSchema.safeParse({
  repository: options.find(opt => opt.name === 'repository')?.value,
  search: options.find(opt => opt.name === 'search')?.value,
});

if (!parsed.success) {
  return { content: '❌ Invalid command options' };
}

const { repository, search } = parsed.data;
```

## environment variables

Each platform has different patterns for accessing environment variables:

- **Cloudflare**: `c.env.VARIABLE_NAME`
- **DigitalOcean**: `process.env.VARIABLE_NAME`
- **Vercel**: `process.env.VARIABLE_NAME`

Handle this in platform-specific files or create an env adapter in core.ts.

## deployment

### Cloudflare Workers
```bash
cd bots/my-bot
npm run deploy:cloudflare
```

Requires `wrangler.toml`:
```toml
name = "my-bot"
main = "src/index.cloudflare.ts"
compatibility_date = "2024-01-01"

[vars]
# Non-secret variables
```

### Digital Ocean Functions
```bash
cd bots/my-bot
doctl serverless deploy
```

Requires `.do/app.yaml`:
```yaml
functions:
  - name: my-bot
    runtime: nodejs:18
    source_dir: src
    entry_point: index.digitalocean.ts
```

### Vercel
```bash
cd bots/my-bot
npm run deploy:vercel
```

Requires `vercel.json`:
```json
{
  "functions": {
    "src/index.vercel.ts": {
      "runtime": "@vercel/node@3"
    }
  }
}
```

## development workflow

1. Make changes in `core.ts` or shared packages
2. Test locally: `npm run dev` (runs Cloudflare dev by default)
3. Build all bots: `npm run build` (from repo root)
4. Deploy to target platform: `npm run deploy:[platform]`

## best practices

1. **Keep core.ts platform-agnostic** - No platform-specific APIs
2. **Validate all inputs** - Use Zod schemas for type safety
3. **Use workspace dependencies** - Reference shared packages with `workspace:*`
4. **Handle errors gracefully** - Always return user-friendly error messages
5. **Test with multiple platforms** - Ensure compatibility across all targets
6. **Document environment variables** - List all required env vars in bot README
