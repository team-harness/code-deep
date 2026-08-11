import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodeIntelServer } from '../src/mcp-server.js';

describe('code-intel MCP server', () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  it('exposes only explore and review and delegates explore to CodeGraph', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const bridge = {
      async callText(name: string, args: Record<string, unknown>): Promise<string> {
        calls.push({ name, args });
        return 'explored source';
      },
    };
    const server = createCodeIntelServer({ projectPath: '/repo', bridge });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    clients.push(client);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['explore', 'review']);

    const result = await client.callTool({
      name: 'explore',
      arguments: { query: 'AuthService login' },
    });
    expect(result.content).toContainEqual({ type: 'text', text: 'explored source' });
    expect(calls).toEqual([
      {
        name: 'codegraph_explore',
        args: {
          query: 'AuthService login',
          maxFiles: 12,
          projectPath: '/repo',
        },
      },
    ]);
  });
});
