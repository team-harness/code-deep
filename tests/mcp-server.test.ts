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
    const ensured: string[] = [];
    const server = createCodeIntelServer({
      projectPath: '/repo',
      bridge,
      ensureIndex: async (projectPath) => { ensured.push(projectPath); },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    clients.push(client);
    await client.connect(clientTransport);

    const instructions = client.getInstructions();
    expect(instructions).toContain('Prefer these code-intel MCP tools over shell commands');
    expect(instructions).toContain('Do not probe the code-intel CLI when MCP tools are available');
    expect(instructions).toContain('Refer to this capability as code-intel');
    expect(instructions).toContain('Do not tell the user you are switching to CodeGraph');
    expect(instructions).not.toContain('share one persistent CodeGraph connection');

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['explore', 'review']);
    expect(tools.tools[0]?.description).toContain('task goal');
    expect(tools.tools[0]?.description).toContain('Automatically initializes');
    expect(tools.tools[0]?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools[0]?.inputSchema.properties?.projectPath?.description)
      .toContain('absolute Git root');
    expect(tools.tools[1]?.description).toContain('descending risk order');
    expect(tools.tools[1]?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools[1]?.inputSchema.properties?.detailLevel).toMatchObject({
      type: 'string',
      enum: ['minimal', 'standard'],
      default: 'minimal',
    });
    expect(tools.tools[1]?.inputSchema).not.toHaveProperty('allOf');
    expect(tools.tools[1]?.inputSchema).not.toHaveProperty('oneOf');
    expect(tools.tools[1]?.inputSchema).not.toHaveProperty('anyOf');
    expect(tools.tools[1]?.outputSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining([
        'schemaVersion', 'detailLevel', 'summary', 'files', 'reviewItems',
        'reviewItemsOmitted', 'riskSignals', 'ignoredPaths',
      ]),
    });
    expect(tools.tools[1]?.outputSchema?.required).not.toContain('markdown');

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
    expect(ensured).toEqual(['/repo']);
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
    const server = createCodeIntelServer({
      projectPath: '/repo',
      bridge,
      ensureIndex: async () => {},
    });
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
      detailLevel: string;
      reviewItems: Array<Record<string, unknown>>;
      files: Array<Record<string, unknown>>;
      ignoredPaths: string[];
    };

    expect(structured.schemaVersion).toBe(2);
    expect(structured.detailLevel).toBe('minimal');
    expect(structured.ignoredPaths).toEqual([]);
    expect(structured.reviewItems).toEqual([
      expect.objectContaining({
        id: 'src/auth.ts:login:1',
        tests: expect.objectContaining({
          status: 'linked',
          relatedFiles: ['tests/auth.test.ts'],
        }),
      }),
    ]);
    expect(structured).not.toHaveProperty('markdown');
    expect(structured).not.toHaveProperty('impacts');
    expect(structured).not.toHaveProperty('graphContext');
    expect(structured).toHaveProperty('reviewItemsOmitted', 0);
    expect(structured.files[0]).not.toHaveProperty('patch');
    expect(structured.files[0]).not.toHaveProperty('graphSummary');
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('## Review priorities'),
    }));
    expect(result.content).not.toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('## Diff'),
    }));
  });

  it('reports review items omitted by minimal detail', async () => {
    const bridge = {
      async callText(name: string): Promise<string> {
        if (name === 'codegraph_node') {
          return Array.from({ length: 5 }, (_, index) =>
            `- \`item${index + 1}\` (function) — :${index + 1}`).join('\n');
        }
        if (name === 'codegraph_impact') return '**Impact: "item" affects 0 symbols**';
        return '';
      },
    };
    const server = createCodeIntelServer({
      projectPath: '/repo',
      bridge,
      ensureIndex: async () => {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    clients.push(client);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'review',
      arguments: {
        diff: [
          'diff --git a/src/items.ts b/src/items.ts',
          '--- a/src/items.ts',
          '+++ b/src/items.ts',
          '@@ -0,0 +1,5 @@',
          '+one', '+two', '+three', '+four', '+five',
        ].join('\n'),
      },
    });
    const structured = result.structuredContent as {
      reviewItems: unknown[];
      reviewItemsOmitted: number;
    };

    expect(structured.reviewItems).toHaveLength(3);
    expect(structured.reviewItemsOmitted).toBe(2);
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('2 additional review items omitted'),
    }));
  });

  it('returns the complete report only when standard detail is requested', async () => {
    const bridge = {
      async callText(name: string): Promise<string> {
        if (name === 'codegraph_node') return '- `login` (function) — :1';
        if (name === 'codegraph_impact') return '**Impact: "login" affects 0 symbols**';
        return 'login context';
      },
    };
    const server = createCodeIntelServer({
      projectPath: '/repo',
      bridge,
      ensureIndex: async () => {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    clients.push(client);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'review',
      arguments: {
        detailLevel: 'standard',
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
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured.detailLevel).toBe('standard');
    expect(structured).toHaveProperty('impacts');
    expect(structured).toHaveProperty('graphContext', 'login context');
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('## Diff'),
    }));
  });

  it('compacts changed lines in MCP structured content', async () => {
    const server = createCodeIntelServer({
      projectPath: '/repo',
      bridge: { async callText(): Promise<string> { return ''; } },
      ensureIndex: async () => {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    clients.push(client);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'review',
      arguments: {
        diff: [
          'diff --git a/notes.md b/notes.md',
          '--- a/notes.md',
          '+++ b/notes.md',
          '@@ -1,0 +1,4 @@',
          '+one',
          '+two',
          '+three',
          '+four',
          '@@ -9,0 +13,2 @@',
          '+thirteen',
          '+fourteen',
        ].join('\n'),
      },
    });
    const structured = result.structuredContent as {
      files: Array<Record<string, unknown>>;
    };

    expect(structured.files[0]).toMatchObject({
      changedLineCount: 6,
      changedLineRanges: [
        { start: 1, end: 4 },
        { start: 13, end: 14 },
      ],
    });
    expect(structured.files[0]).not.toHaveProperty('changedLines');
  });

  it('rejects a caller-supplied diff combined with a Git range', async () => {
    const calls: string[] = [];
    const ensured: string[] = [];
    const bridge = {
      async callText(name: string): Promise<string> {
        calls.push(name);
        return '';
      },
    };
    const server = createCodeIntelServer({
      projectPath: '/repo',
      bridge,
      ensureIndex: async (projectPath) => { ensured.push(projectPath); },
    });
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
    expect(ensured).toEqual([]);
  });
});
