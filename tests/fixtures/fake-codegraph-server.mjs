import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, writeFileSync } from 'node:fs';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'fake-codegraph', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const startupDelayArg = process.argv.find((arg) => arg.startsWith('--startup-delay='));
const startupDelay = startupDelayArg
  ? Number.parseInt(startupDelayArg.slice('--startup-delay='.length), 10)
  : 0;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'codegraph_explore',
      description: 'Fake explore tool',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const query = request.params.arguments?.query;
  if (typeof query === 'string' && query.startsWith('crash-once:')) {
    const marker = query.slice('crash-once:'.length);
    if (!existsSync(marker)) {
      writeFileSync(marker, 'crashed');
      process.exit(23);
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          pid: process.pid,
          name: request.params.name,
          arguments: request.params.arguments,
        }),
      },
    ],
  };
});

if (startupDelay > 0) {
  await new Promise((resolve) => setTimeout(resolve, startupDelay));
}
await server.connect(new StdioServerTransport());
