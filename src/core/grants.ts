import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';
import { newId } from '../ids.js';

export type GrantResourceType = 'agent' | 'memory_namespace' | 'workflow';

export type GrantStatus = 'pending' | 'accepted';

export type Grant = {
  id: string;
  resourceType: GrantResourceType;
  resourceId: string;
  ownerId: string;
  granteeId: string;
  status: GrantStatus;
  createdAt: string;
};

type GrantRow = {
  id: string;
  resource_type: string;
  resource_id: string;
  owner_id: string;
  grantee_id: string;
  status: string;
  created_at: string;
};

function toGrant(row: GrantRow): Grant {
  return {
    id: row.id,
    resourceType: row.resource_type as GrantResourceType,
    resourceId: row.resource_id,
    ownerId: row.owner_id,
    granteeId: row.grantee_id,
    status: (row.status === 'pending' ? 'pending' : 'accepted') as GrantStatus,
    createdAt: row.created_at
  };
}

/**
 * Peer-to-peer sharing: one owner granting one named grantee access to one
 * resource they own. Distinct from the admin-only `shared: true` sentinel
 * (owner_id === SINGLE_OWNER, visible to everyone) — a grant names exactly
 * one grantee and nothing is shared by default. Only the resource's own
 * owner or an admin may create or remove a grant; that check happens at the
 * call site (`getManaged`), not here — this store just holds the rows.
 */
export class GrantStore {
  constructor(private readonly db: Db) {}

  async grant(
    resourceType: GrantResourceType,
    resourceId: string,
    ownerId: string,
    granteeId: string
  ): Promise<Grant> {
    if (granteeId === ownerId) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        'Cannot share a resource with its own owner.',
        'Pick a different granteeId.'
      );
    }
    if (granteeId.trim() === '') {
      throw new OrchestratorError('INVALID_INPUT', '"granteeId" must be a non-empty string.');
    }

    const now = new Date().toISOString();
    // A share starts pending and confers nothing until the grantee accepts.
    // Re-sharing an accepted row must not demote it back to pending, so the
    // conflict path keeps the existing status untouched.
    await this.db
      .prepare(
        `INSERT INTO resource_grants (id, resource_type, resource_id, owner_id, grantee_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (resource_type, resource_id, owner_id, grantee_id) DO NOTHING`
      )
      .run(newId('grant'), resourceType, resourceId, ownerId, granteeId, now);

    const row = (await this.db
      .prepare(
        `SELECT * FROM resource_grants WHERE resource_type = ? AND resource_id = ? AND owner_id = ? AND grantee_id = ?`
      )
      .get(resourceType, resourceId, ownerId, granteeId)) as GrantRow;
    return toGrant(row);
  }

  /**
   * Accept a pending share. Only the named grantee may do this — the caller
   * proves it by naming their own granteeId, checked at the call site via
   * the principal. Throws NOT_FOUND when there is no pending share to accept.
   */
  async accept(
    resourceType: GrantResourceType,
    resourceId: string,
    ownerId: string,
    granteeId: string
  ): Promise<Grant> {
    const updated = (await this.db
      .prepare(
        `UPDATE resource_grants SET status = 'accepted'
          WHERE resource_type = ? AND resource_id = ? AND owner_id = ? AND grantee_id = ? AND status = 'pending'
        RETURNING *`
      )
      .all(resourceType, resourceId, ownerId, granteeId)) as GrantRow[];
    if (updated.length === 0) {
      // Either never shared, already accepted, or rejected — same answer, so
      // a caller cannot probe which of those holds.
      throw new OrchestratorError('NOT_FOUND', 'No pending share to accept for this resource.');
    }
    return toGrant(updated[0] as GrantRow);
  }

  /**
   * Decline a pending share: the row goes away, so the owner may share again
   * later. Returns true when a pending row was actually removed.
   */
  async reject(
    resourceType: GrantResourceType,
    resourceId: string,
    ownerId: string,
    granteeId: string
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `DELETE FROM resource_grants
          WHERE resource_type = ? AND resource_id = ? AND owner_id = ? AND grantee_id = ? AND status = 'pending'`
      )
      .run(resourceType, resourceId, ownerId, granteeId);
    return result.changes > 0;
  }

  /** Pending shares addressed to one grantee — their inbox, for accept/reject. */
  async listIncoming(resourceType: GrantResourceType, granteeId: string): Promise<Grant[]> {
    const rows = (await this.db
      .prepare(
        `SELECT * FROM resource_grants WHERE resource_type = ? AND grantee_id = ? AND status = 'pending' ORDER BY created_at ASC`
      )
      .all(resourceType, granteeId)) as GrantRow[];
    return rows.map(toGrant);
  }

  async revoke(
    resourceType: GrantResourceType,
    resourceId: string,
    ownerId: string,
    granteeId: string
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `DELETE FROM resource_grants WHERE resource_type = ? AND resource_id = ? AND owner_id = ? AND grantee_id = ?`
      )
      .run(resourceType, resourceId, ownerId, granteeId);
    return result.changes > 0;
  }

  /**
   * Whether `granteeId` has an *accepted* grant for this resource. A pending
   * share confers no visibility — the grantee must accept first, and until
   * then the resource reads as not shared at all.
   */
  async hasGrant(
    resourceType: GrantResourceType,
    resourceId: string,
    ownerId: string,
    granteeId: string
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 FROM resource_grants WHERE resource_type = ? AND resource_id = ? AND owner_id = ? AND grantee_id = ? AND status = 'accepted'`
      )
      .get(resourceType, resourceId, ownerId, granteeId);
    return row !== undefined;
  }

  /** Every grantee a resource has been shared with, for its owner to review or revoke. */
  async listGrantees(
    resourceType: GrantResourceType,
    resourceId: string,
    ownerId: string
  ): Promise<Grant[]> {
    const rows = (await this.db
      .prepare(
        `SELECT * FROM resource_grants WHERE resource_type = ? AND resource_id = ? AND owner_id = ? ORDER BY created_at ASC`
      )
      .all(resourceType, resourceId, ownerId)) as GrantRow[];
    return rows.map(toGrant);
  }

  /**
   * Every resource id of this type granted to `granteeId` and accepted,
   * regardless of owner. Pending shares are excluded — they confer no
   * visibility until accepted. Used to widen a list/find query — safe for
   * agents, where a resource id already identifies exactly one owner; callers
   * with per-owner-ambiguous resource ids (e.g. a memory namespace name) must
   * disambiguate with `hasGrant` instead of relying on this alone.
   */
  async listGrantedResourceIds(resourceType: GrantResourceType, granteeId: string): Promise<string[]> {
    const rows = (await this.db
      .prepare(
        `SELECT DISTINCT resource_id FROM resource_grants WHERE resource_type = ? AND grantee_id = ? AND status = 'accepted'`
      )
      .all(resourceType, granteeId)) as { resource_id: string }[];
    return rows.map(r => r.resource_id);
  }
}

export type GrantPreset = {
  name: string;
  grants: string[];
  createdAt: string;
  updatedAt: string;
};

type GrantPresetRow = { name: string; spec: string; created_at: string; updated_at: string };

/** One grant names a whole server (`"files"`) or one tool on it (`"files/read_file"`). */
const GRANT_PATTERN = /^[^/\s]+(\/[^/\s]+)?$/;

export function assertValidGrants(grants: readonly string[]): void {
  for (const grant of grants) {
    if (!GRANT_PATTERN.test(grant)) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        `Grant "${grant}" must be "server" or "server/tool".`,
        'Examples: "files" for everything one server offers, "files/read_file" for a single tool.'
      );
    }
  }
}

function toPreset(row: GrantPresetRow): GrantPreset {
  return {
    name: row.name,
    grants: JSON.parse(row.spec) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Named tool-grant bundles an admin curates once (`grant_preset_save`) for
 * anyone to stamp onto an agent at create time (`agent_create grantPreset`).
 * Global like agent_templates — saving is admin-gated, using is not — and
 * the grants are copied onto the agent, never linked: renaming a server
 * later cannot silently change what existing agents may call.
 */
export class GrantPresetStore {
  constructor(private readonly db: Db) {}

  async save(name: string, grants: readonly string[]): Promise<GrantPreset> {
    assertValidGrants(grants);
    const unique = [...new Set(grants)];
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO grant_presets (name, spec, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET spec = excluded.spec, updated_at = excluded.updated_at`
      )
      .run(name, JSON.stringify(unique), now, now);
    const preset = await this.get(name);
    if (preset === undefined) throw new Error('grant preset write did not persist');
    return preset;
  }

  async get(name: string): Promise<GrantPreset | undefined> {
    const row = (await this.db.prepare('SELECT * FROM grant_presets WHERE name = ?').get(name)) as
      | GrantPresetRow
      | undefined;
    return row === undefined ? undefined : toPreset(row);
  }

  async list(): Promise<GrantPreset[]> {
    const rows = (await this.db.prepare('SELECT * FROM grant_presets ORDER BY name').all()) as GrantPresetRow[];
    return rows.map(toPreset);
  }
}
