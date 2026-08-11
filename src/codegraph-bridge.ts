import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CallToolResultSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

const require = createRequire(import.meta.url);

export interface CodeGraphBridgeOptions {
  projectPath: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export class CodeGraphBridge {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connecting: Promise<Client> | null = null;
  private closed = false;

  constructor(private readonly options: CodeGraphBridgeOptions) {}

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const firstClient = await this.getClient();
    try {
      return await this.callWithClient(firstClient, name, args);
    } catch (error) {
      if (!isConnectionClosed(error)) throw error;
      await this.invalidate(firstClient);
      const replacement = await this.getClient();
      return this.callWithClient(replacement, name, args);
    }
  }

  async callText(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.callTool(name, args);
    if (result.isError) {
      throw new Error(textFromToolResult(result) || `${name} failed`);
    }
    return textFromToolResult(result);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const activeClient = this.client;
    const pendingConnection = this.connecting;
    this.client = null;
    this.transport = null;
    if (activeClient) await activeClient.close();
    if (pendingConnection) {
      try {
        const pendingClient = await pendingConnection;
        if (pendingClient !== activeClient) await pendingClient.close();
      } catch {
        // A connection aborted by close() is the expected outcome.
      }
    }
  }

  private async getClient(): Promise<Client> {
    if (this.closed) throw new Error('CodeGraph bridge is closed');
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<Client> {
    const params = this.serverParameters();
    const transport = new StdioClientTransport(params);
    const client = new Client(
      { name: 'code-intel-bridge', version: '0.3.1' },
      { capabilities: {} },
    );

    client.onclose = () => {
      if (this.transport === transport) {
        this.transport = null;
        this.client = null;
      }
    };

    await client.connect(transport);
    if (this.closed) {
      await client.close();
      throw new Error('CodeGraph bridge is closed');
    }
    this.transport = transport;
    this.client = client;
    return client;
  }

  private async callWithClient(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const result = await client.callTool(
      { name, arguments: args },
      CallToolResultSchema,
    );
    if (!('content' in result)) {
      throw new Error(`${name} returned an unsupported task result`);
    }
    return CallToolResultSchema.parse(result);
  }

  private async invalidate(client: Client): Promise<void> {
    if (this.client === client) {
      this.client = null;
      this.transport = null;
    }
    try {
      await client.close();
    } catch {
      // The failed transport is usually already closed.
    }
  }

  private serverParameters(): StdioServerParameters {
    if (this.options.command) {
      return {
        command: this.options.command,
        args: this.options.args,
        cwd: this.options.projectPath,
        env: this.childEnvironment(),
      };
    }

    const codegraphBin = resolveCodeGraphBin();
    return {
      command: process.execPath,
      args: [
        codegraphBin,
        'serve',
        '--mcp',
        '--path',
        this.options.projectPath,
        ...(this.options.args ?? []),
      ],
      cwd: this.options.projectPath,
      env: this.childEnvironment(),
    };
  }

  private childEnvironment(): Record<string, string> {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    return {
      ...inherited,
      CODEGRAPH_MCP_TOOLS: 'explore,node,impact,status',
      ...this.options.env,
    };
  }
}

function isConnectionClosed(error: unknown): boolean {
  return error instanceof Error && /connection (?:is )?closed|not connected/i.test(error.message);
}

export function textFromToolResult(result: CallToolResult): string {
  return result.content
    .filter((item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

export function resolveCodeGraphBin(): string {
  const packageJsonPath = require.resolve('@colbymchenry/codegraph/package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof packageJson.bin === 'string'
    ? packageJson.bin
    : packageJson.bin?.codegraph;
  if (!bin) throw new Error('The installed CodeGraph package does not expose a codegraph bin');
  return join(dirname(packageJsonPath), bin);
}
