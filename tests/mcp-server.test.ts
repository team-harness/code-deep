import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodeDeepServer } from '../src/mcp-server.js';

describe('code-deep MCP server', () => {
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
    const server = createCodeDeepServer({
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
    expect(instructions).toContain('Prefer these code-deep MCP tools over shell commands');
    expect(instructions).toContain('Do not probe the code-deep CLI when MCP tools are available');
    expect(instructions).toContain('Refer to this capability as code-deep');
    expect(instructions).toContain('Do not tell the user you are switching to CodeGraph');
    expect(instructions).not.toContain('share one persistent CodeGraph connection');

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['explore', 'review']);
    expect(tools.tools[0]?.description).toContain('task goal');
    expect(tools.tools[0]?.description).toContain('Automatically initializes');
    expect(tools.tools[0]?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools[0]?.inputSchema.properties?.projectPath?.description)
      .toContain('absolute Git root');
    expect(tools.tools[0]?.inputSchema.properties?.query?.description)
      .toContain('Required focused exploration goal');
    expect(tools.tools[0]?.inputSchema.properties?.detailLevel).toMatchObject({
      type: 'string',
      enum: ['minimal', 'standard'],
      default: 'minimal',
    });
    expect(tools.tools[0]?.outputSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining([
        'schemaVersion', 'detailLevel', 'originalCharacters', 'returnedCharacters',
        'charactersOmitted', 'sourceFilesFound', 'sourceFilesReturned',
        'sourceFilesOmitted', 'returnedSourceFiles', 'omittedSourceFiles',
        'omittedSourceFilesUnlisted', 'truncated',
      ]),
    });
    expect(tools.tools[1]?.description).toContain('descending risk order');
    expect(tools.tools[1]?.description).toContain('Choose exactly one source mode');
    expect(tools.tools[1]?.inputSchema.properties?.diff?.description)
      .toContain('only source selector');
    expect(tools.tools[1]?.inputSchema.properties?.head?.description)
      .toContain('requires base');
    expect(tools.tools[1]?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools[1]?.inputSchema.properties?.detailLevel).toMatchObject({
      type: 'string',
      enum: ['minimal', 'standard'],
      default: 'minimal',
    });
    expect(tools.tools[1]?.inputSchema.properties?.detailLevel?.description)
      .toContain('standard returns the top ten');
    expect(tools.tools[1]?.inputSchema.properties?.maxFiles).toMatchObject({
      minimum: 1,
      maximum: 100,
      default: 20,
    });
    expect(tools.tools[1]?.inputSchema.properties?.maxFiles?.description)
      .toContain('Integer 1-100');
    expect(tools.tools[1]?.inputSchema.properties?.maxSymbols).toMatchObject({
      minimum: 1,
      maximum: 50,
      default: 12,
    });
    expect(tools.tools[1]?.inputSchema.properties?.maxSymbols?.description)
      .toContain('hard limit');
    expect(tools.tools[1]?.inputSchema.properties?.maxSymbols?.description)
      .toContain('global diff totals');
    expect(tools.tools[1]?.inputSchema).not.toHaveProperty('allOf');
    expect(tools.tools[1]?.inputSchema).not.toHaveProperty('oneOf');
    expect(tools.tools[1]?.inputSchema).not.toHaveProperty('anyOf');
    expect(tools.tools[1]?.outputSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining([
        'schemaVersion', 'detailLevel', 'summary', 'files', 'reviewItems',
      ]),
    });
    expect(tools.tools[1]?.outputSchema?.properties?.schemaVersion).toMatchObject({ const: 3 });
    expect(tools.tools[1]?.outputSchema?.required).not.toContain('markdown');
    expect(tools.tools[1]?.outputSchema?.properties).not.toHaveProperty('impacts');
    expect(tools.tools[1]?.outputSchema?.properties).not.toHaveProperty('graphContext');

    const result = await client.callTool({
      name: 'explore',
      arguments: { query: 'AuthService login' },
    });
    expect(result.content).toContainEqual({ type: 'text', text: 'explored source' });
    expect(result.structuredContent).toMatchObject({
      schemaVersion: 1,
      detailLevel: 'minimal',
      originalCharacters: 'explored source'.length,
      returnedCharacters: 'explored source'.length,
      charactersOmitted: 0,
      sourceFilesFound: 0,
      sourceFilesReturned: 0,
      sourceFilesOmitted: 0,
      returnedSourceFiles: [],
      omittedSourceFiles: [],
      omittedSourceFilesUnlisted: 0,
      truncated: false,
    });
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

  it('projects explore source progressively with explicit omission metadata', async () => {
    const sourceBlock = (path: string, marker: string) => [
      `**\`${path}\`** — focused`,
      '',
      '```typescript',
      marker.repeat(7_000),
      '```',
    ].join('\n');
    const raw = [
      '**Flow**',
      '',
      'structural relationship '.repeat(400),
      '',
      '**Source Code**',
      '',
      sourceBlock('src/one.ts', 'a'),
      sourceBlock('src/two.ts', 'b'),
      sourceBlock('src/three.ts', 'c'),
      sourceBlock('src/four.ts', 'd'),
    ].join('\n');
    const server = createCodeDeepServer({
      projectPath: '/repo',
      bridge: { async callText(): Promise<string> { return raw; } },
      ensureIndex: async () => {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    clients.push(client);
    await client.connect(clientTransport);

    const minimal = await client.callTool({
      name: 'explore',
      arguments: { query: 'trace source flow', maxFiles: 12 },
    });
    const minimalText = (minimal.content[0] as { text: string }).text;
    expect(minimalText.length).toBeLessThanOrEqual(8_000);
    expect(minimalText).toContain('src/one.ts');
    expect(minimalText).not.toContain('**`src/two.ts`**');
    expect(minimal.structuredContent).toMatchObject({
      detailLevel: 'minimal',
      originalCharacters: raw.length,
      sourceFilesFound: 4,
      sourceFilesReturned: 1,
      sourceFilesOmitted: 3,
      returnedSourceFiles: ['src/one.ts'],
      omittedSourceFiles: ['src/two.ts', 'src/three.ts', 'src/four.ts'],
      omittedSourceFilesUnlisted: 0,
      truncated: true,
    });
    expect((minimal.structuredContent as { charactersOmitted: number }).charactersOmitted)
      .toBeGreaterThan(0);

    const standard = await client.callTool({
      name: 'explore',
      arguments: { query: 'trace source flow', maxFiles: 12, detailLevel: 'standard' },
    });
    const standardText = (standard.content[0] as { text: string }).text;
    expect(standardText.length).toBeLessThanOrEqual(20_000);
    expect(standardText).toContain('src/one.ts');
    expect(standardText).toContain('src/two.ts');
    expect(standardText).toContain('src/three.ts');
    expect(standardText).not.toContain('**`src/four.ts`**');
    expect(standard.structuredContent).toMatchObject({
      detailLevel: 'standard',
      originalCharacters: raw.length,
      sourceFilesFound: 4,
      sourceFilesReturned: 3,
      sourceFilesOmitted: 1,
      returnedSourceFiles: ['src/one.ts', 'src/two.ts', 'src/three.ts'],
      omittedSourceFiles: ['src/four.ts'],
      omittedSourceFilesUnlisted: 0,
      truncated: true,
    });
    expect((standard.structuredContent as { charactersOmitted: number }).charactersOmitted)
      .toBeGreaterThan(0);
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
    const server = createCodeDeepServer({
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
      ignoredPaths?: string[];
    };

    expect(structured.schemaVersion).toBe(3);
    expect(structured.detailLevel).toBe('minimal');
    expect(structured.ignoredPaths).toBeUndefined();
    expect(structured.reviewItems).toEqual([
      expect.objectContaining({
        symbol: 'function login @ src/auth.ts:1',
        tests: 'linked',
        testFiles: ['tests/auth.test.ts'],
      }),
    ]);
    expect(structured).not.toHaveProperty('markdown');
    expect(structured).not.toHaveProperty('impacts');
    expect(structured).not.toHaveProperty('graphContext');
    expect(structured).not.toHaveProperty('omitted');
    expect(structured.files[0]).not.toHaveProperty('graphConfidence');
    expect(structured.files[0]).not.toHaveProperty('graphWarnings');
    expect(structured.files[0]).not.toHaveProperty('omittedSymbols');
    expect(structured.reviewItems[0]).not.toHaveProperty('mapping');
    expect(structured.reviewItems[0]).not.toHaveProperty('impactConfidence');
    expect(structured.reviewItems[0]).not.toHaveProperty('omittedTargets');
    expect(structured.reviewItems[0]).not.toHaveProperty('omittedTestFiles');
    expect(structured.files[0]).not.toHaveProperty('patch');
    expect(structured.files[0]).not.toHaveProperty('graphSummary');
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('1. medium:30 login @ src/auth.ts:1'),
    }));
    expect(result.content).not.toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('## Diff'),
    }));
    expect(result.content).not.toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('## Changed symbols'),
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
    const server = createCodeDeepServer({
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
      omitted?: { reviewItems?: number };
    };

    expect(structured.reviewItems).toHaveLength(3);
    expect(structured.omitted?.reviewItems).toBe(2);
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('2 omitted'),
    }));
  });

  it('returns a bounded standard projection without raw review payloads', async () => {
    const bridge = {
      async callText(name: string): Promise<string> {
        if (name === 'codegraph_node') return '- `login` (function) — :1';
        if (name === 'codegraph_impact') return '**Impact: "login" affects 0 symbols**';
        return 'login context';
      },
    };
    const server = createCodeDeepServer({
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
    expect(structured).not.toHaveProperty('impacts');
    expect(structured).not.toHaveProperty('graphContext');
    expect(structured).not.toHaveProperty('omitted');
    expect(result.content).not.toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('## Diff'),
    }));
    expect(result.content).not.toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('login context'),
    }));
  });

  it('separates standard response size from the symbol analysis budget', async () => {
    const bridge = {
      async callText(name: string): Promise<string> {
        if (name === 'codegraph_node') {
          return Array.from({ length: 12 }, (_, index) =>
            `- \`item${index + 1}\` (function) — :${index + 1}`).join('\n');
        }
        if (name === 'codegraph_impact') {
          return [
            '**Impact: "item" affects 5 symbols**',
            '',
            ...Array.from({ length: 5 }, (_, index) => [
              `**tests/item${index + 1}.test.ts:**`,
              `item test ${index + 1}:${index + 1}`,
              '',
            ]).flat(),
          ].join('\n');
        }
        return 'large graph context that must stay out of the response';
      },
    };
    const server = createCodeDeepServer({
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
        maxSymbols: 12,
        diff: [
          'diff --git a/src/items.ts b/src/items.ts',
          '--- a/src/items.ts',
          '+++ b/src/items.ts',
          '@@ -0,0 +1,12 @@',
          ...Array.from({ length: 12 }, (_, index) => `+item${index + 1}`),
        ].join('\n'),
      },
    });
    const structured = result.structuredContent as {
      summary: { scope: { symbols: string } };
      files: Array<{
        symbols: string[];
        omittedSymbols?: number;
      }>;
      reviewItems: Array<{
        impact: number;
        targets?: string[];
        omittedTargets?: number;
        testFiles?: string[];
        omittedTestFiles?: number;
      }>;
      omitted?: { reviewItems?: number };
    };

    expect(structured.summary.scope.symbols).toBe('12/12');
    expect(structured.files[0]?.symbols).toHaveLength(5);
    expect(structured.files[0]?.omittedSymbols).toBe(7);
    expect(structured.reviewItems).toHaveLength(10);
    expect(structured.omitted?.reviewItems).toBe(2);
    expect(structured.reviewItems[0]?.impact).toBe(5);
    expect(structured.reviewItems[0]).not.toHaveProperty('affectedSymbols');
    expect(structured.reviewItems[0]).not.toHaveProperty('changedFiles');
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('+7 priorities in structuredContent; 2 omitted'),
    }));
    expect(JSON.stringify(structured).length).toBeLessThan(6_000);
  });

  it('compacts changed lines in MCP structured content', async () => {
    const server = createCodeDeepServer({
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
      delta: '+6/-0',
      lines: '1-4,13-14',
    });
    expect(structured.files[0]).not.toHaveProperty('changedLines');
    expect(structured.files[0]).not.toHaveProperty('changedLineCount');
    expect(structured.files[0]).not.toHaveProperty('changedLineRanges');
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
    const server = createCodeDeepServer({
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

  it('returns actionable guidance when review limits are out of range', async () => {
    const calls: string[] = [];
    const server = createCodeDeepServer({
      projectPath: '/repo',
      bridge: {
        async callText(name: string): Promise<string> {
          calls.push(name);
          return '';
        },
      },
      ensureIndex: async () => {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    clients.push(client);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'review',
      arguments: { maxSymbols: 80 },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('maxSymbols must be an integer from 1 to 50 (default 12)'),
    }));
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('Do not retry with the same invalid value'),
    }));
    expect(calls).toEqual([]);
  });

  it('explains review source-mode errors before retrying', async () => {
    const server = createCodeDeepServer({
      projectPath: '/repo',
      bridge: { async callText(): Promise<string> { throw new Error('must not call bridge'); } },
      ensureIndex: async () => { throw new Error('must not initialize'); },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' });
    clients.push(client);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'review',
      arguments: { head: 'HEAD' },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('head requires base'),
    }));
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('omit head'),
    }));
  });
});
