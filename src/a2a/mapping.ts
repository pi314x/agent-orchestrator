import { Role, TaskState, type Message, type Part, type Task } from '@a2a-js/sdk';
import type { ErrorPayload } from '../errors.js';

export function isTerminalTaskState(state: TaskState): boolean {
  return (
    state === TaskState.TASK_STATE_COMPLETED ||
    state === TaskState.TASK_STATE_CANCELED ||
    state === TaskState.TASK_STATE_FAILED ||
    state === TaskState.TASK_STATE_REJECTED
  );
}

/** A rejected task gets its own code so callers can tell it from a crash. */
export function taskErrorPayload(task: Task): ErrorPayload | undefined {
  const state = task.status?.state;
  if (state === TaskState.TASK_STATE_REJECTED) {
    return {
      code: 'REMOTE_REJECTED',
      message: textFromMessage(task.status?.message) || 'The remote agent rejected the task.',
      hint: 'Rejected tasks are not retried automatically.'
    };
  }
  if (state === TaskState.TASK_STATE_FAILED) {
    return {
      code: 'RUNNER_FAILED',
      message: textFromMessage(task.status?.message) || 'The remote agent failed the task.'
    };
  }
  return undefined;
}

export function textPart(value: string): Part {
  return { content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' };
}

export function dataPart(value: unknown): Part {
  return {
    content: { $case: 'data', value },
    metadata: undefined,
    filename: '',
    mediaType: 'application/json'
  };
}

export function userMessage(messageId: string, text: string, data?: unknown): Message {
  const parts: Part[] = [textPart(text)];
  if (data !== undefined) parts.push(dataPart(data));

  return {
    messageId,
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: []
  };
}

export function textFromParts(parts: readonly Part[] | undefined): string {
  return (parts ?? [])
    .map(part => (part.content?.$case === 'text' ? part.content.value : ''))
    .filter(text => text !== '')
    .join('\n');
}

export function textFromMessage(message: Message | undefined): string {
  return textFromParts(message?.parts);
}

export function structuredFromParts(parts: readonly Part[] | undefined): unknown {
  const found = (parts ?? []).find(part => part.content?.$case === 'data');
  return found?.content?.$case === 'data' ? found.content.value : undefined;
}

export type NormalizedTaskResult = {
  text: string;
  structured?: unknown;
  /** File and data parts become artifacts, exactly like local job output. */
  artifacts: { name: string; content: string; mimeType: string }[];
};

/**
 * Everything coming back from a remote agent is untrusted data: it is stored
 * and returned, never executed, and never allowed to change policy or trust.
 */
export function normalizeTaskResult(task: Task): NormalizedTaskResult {
  const statusText = textFromMessage(task.status?.message);
  const artifactTexts: string[] = [];
  const artifacts: NormalizedTaskResult['artifacts'] = [];
  let structured: unknown;

  for (const artifact of task.artifacts ?? []) {
    const text = textFromParts(artifact.parts);
    if (text !== '') {
      artifactTexts.push(text);
      artifacts.push({
        name: artifact.name || `remote-artifact-${artifacts.length + 1}`,
        content: text,
        mimeType: 'text/plain'
      });
    }

    const data = structuredFromParts(artifact.parts);
    if (data !== undefined && structured === undefined) structured = data;
  }

  if (structured === undefined) structured = structuredFromParts(task.status?.message?.parts);

  const text = [statusText, ...artifactTexts].filter(part => part !== '').join('\n');

  return { text, artifacts, ...(structured !== undefined && { structured }) };
}
