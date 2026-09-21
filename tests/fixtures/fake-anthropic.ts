import { createServer, type Server } from 'node:http';

/**
 * A protocol-level fake of the Messages API. Not a mock of our runner — it
 * speaks real Anthropic SSE over HTTP, so the runner's streaming parser,
 * tool-use loop and usage accounting all execute for real. Without this the
 * anthropic runner has no test coverage at all short of a live API key.
 */
export type FakeTurn =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; text?: string; calls: { id: string; name: string; input: unknown }[] }
  | { kind: 'refusal'; category?: string }
  | { kind: 'truncated'; text: string };

export interface FakeAnthropic {
  url: string;
  /** Every request body the runner sent, for asserting on what reached the model. */
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function frames(turn: FakeTurn, model: string): string {
  const out: string[] = [];

  out.push(
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 0 }
      }
    })
  );

  let index = 0;

  const emitText = (text: string): void => {
    out.push(
      sse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' }
      })
    );
    out.push(
      sse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text }
      })
    );
    out.push(sse('content_block_stop', { type: 'content_block_stop', index }));
    index += 1;
  };

  if (turn.kind === 'text' || turn.kind === 'truncated') emitText(turn.text);
  if (turn.kind === 'refusal') emitText('');
  if (turn.kind === 'tools') {
    if (turn.text !== undefined) emitText(turn.text);

    for (const call of turn.calls) {
      out.push(
        sse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} }
        })
      );
      out.push(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) }
        })
      );
      out.push(sse('content_block_stop', { type: 'content_block_stop', index }));
      index += 1;
    }
  }

  const stopReason =
    turn.kind === 'tools'
      ? 'tool_use'
      : turn.kind === 'refusal'
        ? 'refusal'
        : turn.kind === 'truncated'
          ? 'max_tokens'
          : 'end_turn';

  out.push(
    sse('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
        ...(turn.kind === 'refusal' && {
          stop_details: { type: 'refusal', category: turn.category ?? 'cyber' }
        })
      },
      usage: { output_tokens: 7 }
    })
  );
  out.push(sse('message_stop', { type: 'message_stop' }));

  return out.join('');
}

/** Serves one scripted turn per request, in order. */
export async function startFakeAnthropic(turns: readonly FakeTurn[]): Promise<FakeAnthropic> {
  const requests: Record<string, unknown>[] = [];
  let turnIndex = 0;

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += String(chunk);
    });

    req.on('end', () => {
      const parsed = body === '' ? {} : (JSON.parse(body) as Record<string, unknown>);
      requests.push(parsed);

      const turn = turns[turnIndex] ?? { kind: 'text' as const, text: '(fake ran out of turns)' };
      turnIndex += 1;

      const model = typeof parsed['model'] === 'string' ? parsed['model'] : 'sonnet-5';

      if (parsed['stream'] === true) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        });
        res.end(frames(turn, model));
        return;
      }

      // Non-streaming path, used by messages.parse for structured output.
      const content =
        turn.kind === 'tools'
          ? turn.calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input }))
          : [{ type: 'text', text: turn.kind === 'refusal' ? '' : turn.text }];

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model,
          content,
          stop_reason:
            turn.kind === 'refusal' ? 'refusal' : turn.kind === 'truncated' ? 'max_tokens' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 11, output_tokens: 7 }
        })
      );
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}
