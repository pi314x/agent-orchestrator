import { monotonicFactory } from 'ulid';

// Plain ulid() can emit out-of-order ids within a single millisecond, which
// would break the id-as-cursor pagination in JobStore and AgentRegistry.
const ulid = monotonicFactory();

export const ID_PREFIXES = {
  agent: 'agt_',
  card: 'crd_',
  template: 'tpl_',
  job: 'job_',
  workflow: 'wf_',
  workflowRun: 'wfr_',
  message: 'msg_',
  artifact: 'art_',
  approval: 'apr_',
  toolServer: 'ts_',
  event: 'evt_',
  grant: 'grt_',
  channel: 'chan_',
  instance: 'inst_',
  schedule: 'sch_',
  webhook: 'wh_'
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type PrefixedId<K extends IdKind = IdKind> = `${(typeof ID_PREFIXES)[K]}${string}`;

/** Mint a prefixed ULID. Every ID in the system comes from here. */
export function newId<K extends IdKind>(kind: K): PrefixedId<K> {
  return `${ID_PREFIXES[kind]}${ulid()}` as PrefixedId<K>;
}

export function isId<K extends IdKind>(kind: K, value: string): value is PrefixedId<K> {
  return value.startsWith(ID_PREFIXES[kind]) && value.length > ID_PREFIXES[kind].length;
}
