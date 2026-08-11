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
    expect(tools.tools[0]?.description).toContain('task goal');
    expect(tools.tools[0]?.inputSchema.properties?.projectPath?.description)
      .toContain('absolute Git root');
    expect(tools.tools[1]?.description).toContain('descending risk order');
    expect(tools.tools[1]?.outputSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining([
        'schemaVersion', 'summary', 'files', 'impacts', 'reviewItems',
        'riskSignals', 'graphContext', 'markdown',
      ]),
    });

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

  it('returns versioned review items through MCP structured content', async () => {
    const bridge = {
      async callText(name: string): Promise<string> {
        if (name === 'codegraph_node') return '- `login` (function) — :1';
        if (name === 'codegraph_impact') {
          return [
            '**Impact: "login" affects 2 symbols**',
            '',
            '**src/auth.ts:**',
            'login:1',
            '',
            '**tests/auth.test.ts:**',
            'login test:8',
          ].join('\n');
        }
        return 'login context';
      },
    };
    const server = createCodeIntelServer({ projectPath: '/repo', bridge });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    clients.push(client);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'review',
      arguments: {
        diff: [
          'diff --git a/src/auth.ts b/src/auth.ts',
          '--- a/src/auth.ts',
          '+++ b/src/auth.ts',
          '@@ -1 +1 @@',
          '-export function login() { return false }',
          '+export function login() { return true }',
        ].join('\n'),
      },
    });
    const structured = result.structuredContent as {
      schemaVersion: number;
      reviewItems: Array<Record<string, unknown>>;
    };

    expect(structured.schemaVersion).toBe(1);
    expect(structured.reviewItems).toEqual([
      expect.objectContaining({
        id: 'src/auth.ts:login:1',
        tests: expect.objectContaining({
          status: 'linked',
          relatedFiles: ['tests/auth.test.ts'],
        }),
      }),
    ]);
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('## Review priorities'),
    }));
  });

  it('rejects a caller-supplied diff combined with a Git range', async () => {
    const calls: string[] = [];
    const bridge = {
      async callText(name: string): Promise<string> {
        calls.push(name);
        return '';
      },
    };
    const server = createCodeIntelServer({ projectPath: '/repo', bridge });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    clients.push(client);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'review',
      arguments: {
        diff: 'diff --git a/a.ts b/a.ts',
        base: 'main',
        head: 'HEAD',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('diff cannot be combined with base or head'),
    }));
    expect(calls).toEqual([]);
  });
});
