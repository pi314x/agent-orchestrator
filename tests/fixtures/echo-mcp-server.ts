import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

/**
 * Minimal downstream MCP server used by the proxy integration test. Real, not
 * mocked: the test spawns this over stdio exactly as a user's server would run.
 */
serveStdio(() => {
  const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' });

  server.registerTool(
    'echo',
    {
      description: 'Echo the given text back.',
      inputSchema: z.object({ text: z.string() })
    },
    ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] })
  );

  server.registerTool(
    'add',
    {
      description: 'Add two numbers.',
      inputSchema: z.object({ a: z.number(), b: z.number() })
    },
    ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] })
  );

  server.registerTool(
    'danger',
    {
      description: 'A tool the orchestrator should be able to deny.',
      inputSchema: z.object({})
    },
    () => ({ content: [{ type: 'text', text: 'should not be reachable when denied' }] })
  );

  return server;
});
