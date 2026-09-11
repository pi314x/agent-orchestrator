export interface StatusInputs {
  version: string;
  profile: string;
  transport: string;
  protocolEra: string;
  schemaVersion: number;
  latestSchemaVersion: number;
  a2aEnabled: boolean;
  maxConcurrency: number;
  maxDepth: number;
  uptimeSec: number;
  jobs: { queued: number; running: number; blocked: number };
}

// A type alias, not an interface: object-literal types carry an implicit index
// signature, so this stays assignable to the tool layer's structuredContent.
export type OrchestratorStatus = {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSec: number;
  toolProfile: string;
  transport: string;
  protocolEra: string;
  database: {
    schemaVersion: number;
    latestSchemaVersion: number;
    migrationsPending: boolean;
  };
  jobs: {
    queued: number;
    running: number;
    blocked: number;
  };
  limits: {
    maxConcurrency: number;
    maxDepth: number;
  };
  a2a: {
    enabled: boolean;
  };
};

export function buildStatus(inputs: StatusInputs): OrchestratorStatus {
  const migrationsPending = inputs.schemaVersion < inputs.latestSchemaVersion;

  return {
    status: migrationsPending ? 'degraded' : 'ok',
    version: inputs.version,
    uptimeSec: Math.round(inputs.uptimeSec),
    toolProfile: inputs.profile,
    transport: inputs.transport,
    protocolEra: inputs.protocolEra,
    database: {
      schemaVersion: inputs.schemaVersion,
      latestSchemaVersion: inputs.latestSchemaVersion,
      migrationsPending
    },
    jobs: inputs.jobs,
    limits: {
      maxConcurrency: inputs.maxConcurrency,
      maxDepth: inputs.maxDepth
    },
    a2a: {
      enabled: inputs.a2aEnabled
    }
  };
}
