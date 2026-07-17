import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('server auth bootstrap', () => {
  it('registers the complete user auth middleware chain', () => {
    const source = readFileSync('packages/server/src/index.ts', 'utf8')

    expect(source).toContain("import { userAuthMiddleware } from './middleware/user-auth'")
    expect(source).toContain('registerRoutes(app, userAuthMiddleware)')
    expect(source).not.toContain('registerRoutes(app, [requireUserJwt, resolveUserProfile])')
  })
})
