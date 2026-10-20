import type { FastifyInstance } from 'fastify'
import { timingSafeEqual } from 'node:crypto'

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)
}

export function isRendererOrigin(origin: string | undefined): boolean {
  return origin === 'vscode-file://vscode-app' || /^vscode-webview:\/\/[a-z0-9-]+$/i.test(origin ?? '')
}

function matchesToken(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || Buffer.byteLength(actual) !== Buffer.byteLength(expected))
    return false
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

/** Shared by the real server and HTTP integration tests. */
export function registerLocalAccess(server: FastifyInstance<any, any, any, any>, token: string): void {
  server.addHook('onRequest', async (req, reply) => {
    let host: URL
    try {
      host = new URL(`http://${req.headers.host ?? req.headers[':authority']}`)
    }
    catch { return reply.code(403).send({ error: 'Invalid local host' }) }
    if (host.username || host.password || host.pathname !== '/' || !isLoopbackHost(host.hostname) || Number(host.port || 80) !== req.raw.socket.localPort)
      return reply.code(403).send({ error: 'Invalid local host' })

    const origin = req.headers.origin
    if (origin && !isRendererOrigin(origin))
      return reply.code(403).send({ error: 'Origin denied' })
    if (req.method === 'OPTIONS') {
      if (!isRendererOrigin(origin))
        return reply.code(403).send({ error: 'Origin denied' })
      return
    }
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/health')
      return
    if (url.pathname === '/byok/session' && req.method === 'GET' && isRendererOrigin(origin))
      return
    const sse = url.pathname === '/byok/events' || url.pathname === '/byok/log-stream'
    const supplied = req.headers['x-ccursor-token'] ?? (sse ? url.searchParams.get('access_token') : undefined)
    if (!matchesToken(supplied, token))
      return reply.code(401).send({ error: 'Local access credential required' })
    // Do not leave SSE credentials in request URLs or diagnostic serializers.
    url.searchParams.delete('access_token')
    req.raw.url = url.pathname + url.search
  })
  server.get('/byok/session', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return { token }
  })
}
