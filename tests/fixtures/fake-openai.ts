import { createServer, type Server } from 'node:http';

/**
 * A protocol-level fake of the OpenAI chat-completions API, for the same reason
 * as `fake-anthropic.ts`: the runner's real loop must execute, not a mock of it.
 */
export type FakeChatTurn =
  | { kind: 'text'; text: string; finishReason?: string }
  | { kind: 'tools'; text?: string | null; calls: { id: string; name: string; arguments: unknown }[] }
  | { kind: 'refusal'; refusal?: string }
  | { kind: 'error'; status: number; body?: string };

export interface FakeOpenAi {
  url: string;
  /** Every request body the runner sent, for asserting on what reached the model. */
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

function completion(turn: FakeChatTurn, model: string): unknown {
  const message =
    turn.kind === 'tools'
      ? {
          role: 'assistant',
          content: turn.text ?? null,
          tool_calls: turn.calls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) }
          }))
        }
      : turn.kind === 'refusal'
        ? { role: 'assistant', content: null, refusal: turn.refusal ?? 'I cannot help with that.' }
        : { role: 'assistant', content: turn.kind === 'text' ? turn.text : null };

  const finishReason =
    turn.kind === 'tools'
      ? 'tool_calls'
      : turn.kind === 'text'
        ? (turn.finishReason ?? 'stop')
        : 'content_filter';

  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 }
  };
}

/** Serves one scripted turn per request, in order. */
export async function startFakeOpenAi(turns: readonly FakeChatTurn[]): Promise<FakeOpenAi> {
  const requests: Record<string, unknown>[] = [];
  let turnIndex = 0;

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += String(chunk);
    });

    req.on('end', () => {
      requests.push(body === '' ? {} : (JSON.parse(body) as Record<string, unknown>));

      const turn = turns[turnIndex] ?? { kind: 'text' as const, text: '(fake ran out of turns)' };
      turnIndex += 1;

      if (turn.kind === 'error') {
        res.writeHead(turn.status, { 'content-type': 'application/json' });
        res.end(turn.body ?? '{"error":{"message":"boom"}}');
        return;
      }

      const parsed = JSON.parse(body === '' ? '{}' : body) as Record<string, unknown>;
      const model = typeof parsed['model'] === 'string' ? parsed['model'] : 'gpt-test';

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completion(turn, model)));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}
