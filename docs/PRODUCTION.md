# Production Deployment Guide

This guide covers everything you need to deploy fsx.do to production on Cloudflare Workers.

## Table of Contents

1. [Production Readiness Checklist](#production-readiness-checklist)
2. [Environment Variables](#environment-variables)
3. [Cloudflare Workers Configuration](#cloudflare-workers-configuration)
4. [R2 Bucket Setup](#r2-bucket-setup)
5. [Durable Objects Configuration](#durable-objects-configuration)
6. [Monitoring and Alerting](#monitoring-and-alerting)
7. [Security Checklist](#security-checklist)
8. [Performance Tuning](#performance-tuning)
9. [Deployment Process](#deployment-process)
10. [Rollback Procedures](#rollback-procedures)

---

## Production Readiness Checklist

Before deploying to production, verify the following:

### Infrastructure
- [ ] Cloudflare account with Workers Paid plan (required for Durable Objects)
- [ ] R2 buckets created for warm and cold storage tiers
- [ ] Custom domain configured (optional but recommended)
- [ ] SSL/TLS certificates valid and auto-renewing

### Configuration
- [ ] All environment variables set in Cloudflare dashboard
- [ ] Durable Object migrations applied
- [ ] R2 bucket bindings configured
- [ ] Service bindings configured (if using ecosystem services)

### Security
- [ ] Authentication mechanism implemented
- [ ] CORS policy configured appropriately
- [ ] Rate limiting enabled
- [ ] Path traversal protection verified (PathValidator)
- [ ] Secrets stored securely (not in code)

### Testing
- [ ] All tests passing (`npm test`)
- [ ] Integration tests run against staging environment
- [ ] Load testing completed for expected traffic
- [ ] Failover scenarios tested

### Monitoring
- [ ] Observability enabled in wrangler configuration
- [ ] Error alerting configured
- [ ] Performance baselines established
- [ ] Log retention policy defined

---

## Environment Variables

### Required Variables

Set these in your Cloudflare Workers environment:

| Variable | Description | Example |
|----------|-------------|---------|
| `FSX_ENV` | Environment identifier | `production` |
| `FSX_LOG_LEVEL` | Logging verbosity | `info`, `warn`, `error` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FSX_HOT_MAX_SIZE` | Maximum file size for hot tier (bytes) | `1048576` (1MB) |
| `FSX_WARM_MAX_SIZE` | Maximum file size for warm tier (bytes) | `104857600` (100MB) |
| `FSX_MAX_PATH_LENGTH` | Maximum path length | `4096` |
| `FSX_DEFAULT_FILE_MODE` | Default file permissions | `0644` |
| `FSX_DEFAULT_DIR_MODE` | Default directory permissions | `0755` |
| `FSX_TMP_MAX_AGE` | Temp file cleanup age (ms) | `86400000` (24h) |

### Setting Variables via Wrangler

```bash
# Set a secret (encrypted at rest)
wrangler secret put FSX_API_KEY

# Set a plain text variable
wrangler vars set FSX_ENV=production
```

### In wrangler.toml/wrangler.jsonc

```jsonc
{
  "vars": {
    "FSX_ENV": "production",
    "FSX_LOG_LEVEL": "warn",
    "FSX_HOT_MAX_SIZE": "1048576"
  }
}
```

---

## Cloudflare Workers Configuration

### wrangler.jsonc Production Configuration

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "fsx-do",
  "main": "index.ts",
  "compatibility_date": "2024-12-01",
  "compatibility_flags": ["nodejs_compat"],

  // Custom domain (recommended for production)
  "routes": [
    { "pattern": "fsx.yourdomain.com", "custom_domain": true }
  ],

  // Durable Objects configuration
  "durable_objects": {
    "bindings": [
      { "name": "FSX", "class_name": "FileSystemDO" }
    ]
  },

  // DO migrations - NEVER remove old migrations
  "migrations": [
    { "tag": "v1", "new_classes": ["FileSystemDO"] }
    // Add new migrations here, never modify existing ones
  ],

  // R2 buckets for tiered storage
  "r2_buckets": [
    {
      "binding": "R2",
      "bucket_name": "fsx-storage-prod"
    },
    {
      "binding": "ARCHIVE",
      "bucket_name": "fsx-archive-prod"
    }
  ],

  // Enable observability
  "observability": {
    "enabled": true
  },

  // Production limits
  "limits": {
    "cpu_ms": 50
  }
}
```

### Environment-Specific Configurations

Create separate configuration files for different environments:

```
wrangler.jsonc          # Development
wrangler.staging.jsonc  # Staging
wrangler.prod.jsonc     # Production
```

Deploy with:

```bash
wrangler deploy --config wrangler.prod.jsonc
```

---

## R2 Bucket Setup

### Creating R2 Buckets

```bash
# Create primary storage bucket (warm tier)
wrangler r2 bucket create fsx-storage-prod

# Create archive bucket (cold tier)
wrangler r2 bucket create fsx-archive-prod
```

### R2 Bucket Configuration

1. **Location Hint**: Set location hint close to your primary user base
   ```bash
   wrangler r2 bucket create fsx-storage-prod --location wnam  # Western North America
   ```

2. **Lifecycle Rules**: Configure automatic cleanup for temp files
   ```bash
   # Via Cloudflare Dashboard: R2 > Bucket > Settings > Lifecycle Rules
   # Or via API - delete objects in /tmp/ older than 24 hours
   ```

3. **Access Control**: R2 buckets are private by default. Keep them that way.

### Storage Tier Thresholds

Configure in your application:

```typescript
const tieredFs = new TieredFS({
  hot: env.FSX,           // DO SQLite - fast, small files
  warm: env.R2,           // R2 - medium files
  cold: env.ARCHIVE,      // R2 archive - large/infrequent files
  thresholds: {
    hotMaxSize: 1024 * 1024,      // 1MB -> hot tier
    warmMaxSize: 100 * 1024 * 1024 // 100MB -> warm tier
  }
})
```

### R2 Pricing Considerations

| Operation | Free Tier | Cost (Standard) |
|-----------|-----------|-----------------|
| Class A (writes) | 1M/month | $4.50/million |
| Class B (reads) | 10M/month | $0.36/million |
| Storage | 10GB/month | $0.015/GB-month |

**Optimization Tips**:
- Use hot tier (DO SQLite) for frequently accessed small files
- Batch writes when possible
- Use cold tier for infrequent access data

---

## Durable Objects Configuration

### DO Binding Setup

Durable Objects must be declared in your wrangler configuration:

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "FSX",
        "class_name": "FileSystemDO"
      }
    ]
  }
}
```

### DO Migrations

**Critical**: Never modify or remove existing migrations. Always add new ones.

```jsonc
{
  "migrations": [
    { "tag": "v1", "new_classes": ["FileSystemDO"] },
    { "tag": "v2", "renamed_classes": [{ "from": "OldName", "to": "NewName" }] },
    { "tag": "v3", "deleted_classes": ["DeprecatedDO"] }
  ]
}
```

### DO Naming Strategy

Choose a consistent naming strategy for DO instances:

```typescript
// Option 1: User-based isolation (recommended for multi-tenant)
const id = env.FSX.idFromName(`user-${userId}`)

// Option 2: Project-based isolation
const id = env.FSX.idFromName(`project-${projectId}`)

// Option 3: Unique instance per request (not recommended - creates many DOs)
const id = env.FSX.newUniqueId()
```

### DO Alarm Configuration

For scheduled tasks (cleanup, maintenance):

```typescript
class FileSystemDO extends DurableObject {
  async alarm() {
    // Cleanup temp files
    await this.cleanupTempFiles()

    // Schedule next alarm (e.g., every hour)
    const storage = this.ctx.storage
    await storage.setAlarm(Date.now() + 60 * 60 * 1000)
  }
}
```

---

## Monitoring and Alerting

### Cloudflare Analytics

Enable built-in analytics in wrangler configuration:

```jsonc
{
  "observability": {
    "enabled": true
  }
}
```

### Custom Metrics with Workers Analytics Engine

```typescript
// Track custom metrics
env.ANALYTICS?.writeDataPoint({
  blobs: ['filesystem_operation'],
  doubles: [latencyMs],
  indexes: [operationType]
})
```

### Recommended Alerts

Set up alerts in Cloudflare Dashboard for:

| Metric | Threshold | Severity |
|--------|-----------|----------|
| Error rate | > 1% | Critical |
| P99 latency | > 1000ms | Warning |
| CPU time | > 40ms average | Warning |
| DO storage | > 80% limit | Warning |
| R2 operations | Unexpected spike | Info |

### Error Tracking

Integrate with error tracking services:

```typescript
// Example: Sentry integration
import * as Sentry from '@sentry/cloudflare'

export default Sentry.withSentry(
  (env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 0.1,
  }),
  {
    async fetch(request, env, ctx) {
      // Your handler
    }
  }
)
```

### Logging Best Practices

```typescript
// Structured logging
console.log(JSON.stringify({
  level: 'info',
  operation: 'writeFile',
  path: '/data/file.txt',
  tier: 'hot',
  latencyMs: 15,
  requestId: request.headers.get('cf-ray')
}))
```

### Health Check Endpoint

Implement a health check for monitoring systems:

```typescript
app.get('/health', async (c) => {
  const checks = {
    do: await checkDOHealth(c.env.FSX),
    r2: await checkR2Health(c.env.R2),
    timestamp: new Date().toISOString()
  }

  const healthy = Object.values(checks).every(v => v === true || typeof v === 'string')
  return c.json(checks, healthy ? 200 : 503)
})
```

---

## Security Checklist

### Authentication

Implement authentication for all filesystem operations:

```typescript
// JWT validation example
async function authenticate(request: Request, env: Env): Promise<User | null> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }

  const token = authHeader.slice(7)
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET)
    return payload as User
  } catch {
    return null
  }
}

// Middleware
app.use('*', async (c, next) => {
  const user = await authenticate(c.req.raw, c.env)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  c.set('user', user)
  await next()
})
```

### CORS Configuration

Configure CORS appropriately for your use case:

```typescript
import { cors } from 'hono/cors'

// Restrictive CORS (recommended)
app.use('*', cors({
  origin: ['https://yourdomain.com', 'https://app.yourdomain.com'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
  credentials: true
}))

// For development only - NEVER in production
// app.use('*', cors({ origin: '*' }))
```

### Rate Limiting

Implement rate limiting to prevent abuse:

```typescript
// Using Cloudflare Rate Limiting (recommended)
// Configure in Cloudflare Dashboard: Security > WAF > Rate Limiting Rules

// Or implement in-worker rate limiting
import { rateLimiter } from 'hono-rate-limiter'

app.use(rateLimiter({
  windowMs: 60 * 1000, // 1 minute
  limit: 100,          // 100 requests per window
  keyGenerator: (c) => c.req.header('CF-Connecting-IP') || 'unknown'
}))
```

### Path Traversal Protection

fsx.do includes built-in path traversal protection. Always use the PathValidator:

```typescript
import { pathValidator } from 'fsx.do'

// Validate user-provided paths
app.post('/files/*', async (c) => {
  const userPath = c.req.param('*')

  try {
    // Validates against traversal attacks, null bytes, etc.
    const safePath = pathValidator.validatePath(userPath, '/jail/root')
    // Proceed with safe path
  } catch (error) {
    return c.json({ error: 'Invalid path' }, 400)
  }
})
```

### Security Headers

Add security headers to all responses:

```typescript
import { secureHeaders } from 'hono/secure-headers'

app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
  },
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'strict-origin-when-cross-origin'
}))
```

### Secrets Management

**Never commit secrets to source control.**

```bash
# Store secrets using wrangler
wrangler secret put JWT_SECRET
wrangler secret put API_KEY

# Secrets are encrypted at rest and injected at runtime
```

### Input Validation

Always validate and sanitize user input:

```typescript
import { z } from 'zod'

const writeFileSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(10 * 1024 * 1024), // 10MB max
  encoding: z.enum(['utf-8', 'base64']).optional()
})

app.post('/write', async (c) => {
  const result = writeFileSchema.safeParse(await c.req.json())
  if (!result.success) {
    return c.json({ error: 'Invalid input', details: result.error }, 400)
  }
  // Proceed with validated data
})
```

### Audit Logging

Log security-relevant events:

```typescript
function auditLog(event: {
  action: string
  user: string
  path: string
  result: 'success' | 'denied' | 'error'
  ip: string
  timestamp: string
}) {
  console.log(JSON.stringify({ type: 'audit', ...event }))
  // Optionally send to external logging service
}
```

---

## Performance Tuning

### Storage Tier Optimization

Configure thresholds based on your access patterns:

```typescript
// For read-heavy workloads with small files
const config = {
  hotMaxSize: 2 * 1024 * 1024,  // 2MB in hot tier
  promotionPolicy: 'on-access'  // Auto-promote frequently accessed files
}

// For write-heavy workloads with large files
const config = {
  hotMaxSize: 512 * 1024,       // 512KB in hot tier
  promotionPolicy: 'none'        // No auto-promotion
}
```

### Caching Strategies

```typescript
// Response caching for static files
app.get('/static/*', async (c) => {
  const response = await getFile(c.req.path)

  // Cache immutable content
  c.header('Cache-Control', 'public, max-age=31536000, immutable')
  c.header('ETag', response.hash)

  return c.body(response.data)
})

// Conditional requests
app.get('/files/*', async (c) => {
  const path = c.req.param('*')
  const stats = await fs.stat(path)
  const etag = `"${stats.mtime.getTime()}"`

  if (c.req.header('If-None-Match') === etag) {
    return c.body(null, 304)
  }

  c.header('ETag', etag)
  return c.body(await fs.readFile(path))
})
```

### Connection Reuse

Durable Object stubs maintain connections. Reuse them:

```typescript
// Good: Reuse stub within request
const stub = env.FSX.get(id)
await stub.fetch('/read')
await stub.fetch('/write')  // Reuses connection

// Avoid: Creating new stubs unnecessarily
// const stub1 = env.FSX.get(id)
// const stub2 = env.FSX.get(id)  // Unnecessary
```

### Batch Operations

Batch multiple operations when possible:

```typescript
// Batch read
app.post('/batch/read', async (c) => {
  const { paths } = await c.req.json()
  const results = await Promise.all(
    paths.map(p => fs.readFile(p).catch(e => ({ error: e.message })))
  )
  return c.json(results)
})
```

### CPU Time Optimization

Monitor and optimize CPU-intensive operations:

```typescript
// Avoid synchronous operations
// Bad: JSON.parse of large files in hot path
// Good: Stream and process incrementally

// Use streaming for large files
app.get('/download/:path', async (c) => {
  const stream = await fs.createReadStream(c.req.param('path'))
  return c.body(stream)
})
```

### Memory Management

Workers have a 128MB memory limit. Be mindful of:

```typescript
// Avoid loading entire large files into memory
// Bad:
const data = await fs.readFile('/large-file.bin')

// Good: Use streaming
const stream = await fs.createReadStream('/large-file.bin')
return new Response(stream)
```

---

## Deployment Process

### Pre-deployment

```bash
# 1. Run tests
npm test

# 2. Type check
npm run typecheck

# 3. Build
npm run build

# 4. Review changes
git diff HEAD~1
```

### Deployment

```bash
# Deploy to staging first
wrangler deploy --config wrangler.staging.jsonc

# Verify staging
curl https://staging.fsx.yourdomain.com/health

# Deploy to production
wrangler deploy --config wrangler.prod.jsonc

# Verify production
curl https://fsx.yourdomain.com/health
```

### Post-deployment Verification

```bash
# Check deployment status
wrangler deployments list

# Monitor logs
wrangler tail --format=pretty

# Run smoke tests
npm run test:smoke
```

### Gradual Rollout

Use Cloudflare's gradual rollout feature:

```bash
# Deploy to 10% of traffic
wrangler deployments create --percentage=10

# Monitor metrics, then increase
wrangler deployments create --percentage=50
wrangler deployments create --percentage=100
```

---

## Rollback Procedures

### Quick Rollback

```bash
# List recent deployments
wrangler deployments list

# Rollback to previous version
wrangler rollback

# Or rollback to specific deployment
wrangler rollback <deployment-id>
```

### Manual Rollback

```bash
# Checkout previous version
git checkout <previous-commit>

# Deploy
wrangler deploy --config wrangler.prod.jsonc
```

### Rollback Checklist

1. [ ] Identify the issue and affected deployment
2. [ ] Notify team of rollback
3. [ ] Execute rollback command
4. [ ] Verify health endpoints
5. [ ] Monitor error rates
6. [ ] Investigate root cause
7. [ ] Document incident

### DO Migration Rollback

**Warning**: Durable Object migrations cannot be rolled back. If you need to rollback a DO schema change:

1. Deploy a new migration that reverts the changes
2. Data migrations must be handled manually
3. Consider maintaining backward compatibility in migrations

---

## Appendix: Quick Reference

### Useful Commands

```bash
# Deployment
wrangler deploy                    # Deploy to default environment
wrangler deploy --env production   # Deploy to specific environment
wrangler rollback                  # Rollback to previous version

# Debugging
wrangler tail                      # Stream logs
wrangler tail --format=pretty      # Pretty-printed logs
wrangler tail --search="error"     # Filter logs

# Secrets
wrangler secret put <NAME>         # Add secret
wrangler secret list               # List secrets
wrangler secret delete <NAME>      # Remove secret

# R2
wrangler r2 bucket list            # List buckets
wrangler r2 object get <bucket> <key>  # Download object
```

### Environment URLs

| Environment | URL | Purpose |
|-------------|-----|---------|
| Development | `http://localhost:8787` | Local testing |
| Staging | `https://staging.fsx.do` | Pre-production testing |
| Production | `https://fsx.do` | Live traffic |

### Support Contacts

- Cloudflare Status: https://www.cloudflarestatus.com/
- Cloudflare Support: https://support.cloudflare.com/
- fsx.do Issues: https://github.com/dot-do/fsx/issues
