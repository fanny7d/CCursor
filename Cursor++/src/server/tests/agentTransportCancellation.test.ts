import { fromJson } from '@bufbuild/protobuf'
import { createClient } from '@connectrpc/connect'
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify'
import { createConnectTransport } from '@connectrpc/connect-node'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AgentClientMessageSchema, AgentService } from '../gen/agent_v1_pb'
import { createEphemeralSession, getOrCreateSession, markSessionInputClosed, pushSessionMessage } from '../handlers/agent/session'
import { heartbeat } from '../handlers/agent/stream'
import registerAgentService from '../services/core/AgentService'

const fixture = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../handlers/agent/agentOrchestrator', () => ({ handleRunRequest: (...args: unknown[]) => fixture.run(...args) }))

it('connectRPC client disconnect aborts the live SSE session while its upstream is waiting', async () => {
  const session = getOrCreateSession('transport-disconnect')
  pushSessionMessage(session, { runRequest: {} })
  let upstreamClosed = false
  fixture.run.mockImplementation(async function* (_msg, current) {
    yield heartbeat()
    await new Promise<void>((resolve) => {
      current.controller.signal.addEventListener('abort', () => {
        upstreamClosed = true
        resolve()
      }, { once: true })
    })
  })
  const server = Fastify()
  await server.register(fastifyConnectPlugin, { routes: registerAgentService })
  await server.listen({ host: '127.0.0.1', port: 0 })
  const transport = createConnectTransport({ baseUrl: `http://127.0.0.1:${(server.server.address() as { port: number }).port}`, httpVersion: '1.1' })
  const controller = new AbortController()
  const stream = createClient(AgentService, transport).runSSE({ requestId: session.requestId }, { signal: controller.signal })[Symbol.asyncIterator]()
  try {
    await stream.next()
    controller.abort()
    await expect(stream.next()).rejects.toThrow()
    await vi.waitFor(() => expect(upstreamClosed).toBe(true))
    expect(session.closed).toBe(true)
  }
  finally {
    controller.abort()
    await server.close()
  }
})

it('ending only the inbound half of bidi does not cancel the outbound response', async () => {
  const session = createEphemeralSession('half-close')
  markSessionInputClosed(session)
  expect(session.inputClosed).toBe(true)
  expect(session.closed).toBe(false)
  expect(session.controller.signal.aborted).toBe(false)
  fixture.run.mockImplementation(async function* (_msg, current) {
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(current.controller.signal.aborted).toBe(false)
    yield heartbeat()
  })
  const server = Fastify({ http2: true })
  await server.register(fastifyConnectPlugin, { routes: registerAgentService })
  await server.listen({ host: '127.0.0.1', port: 0 })
  const transport = createConnectTransport({ baseUrl: `http://127.0.0.1:${(server.server.address() as { port: number }).port}`, httpVersion: '2' })
  const requests = (async function* () {
    yield fromJson(AgentClientMessageSchema, { runRequest: {} })
  })()
  try {
    const frames = []
    for await (const frame of createClient(AgentService, transport).run(requests)) frames.push(frame)
    expect(frames.length).toBe(1)
  }
  finally {
    // The Node HTTP/2 client pools a session; close active HTTP/2 connections.
    await server.close()
  }
})
