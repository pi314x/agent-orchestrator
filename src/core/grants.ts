import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';
import { newId } from '../ids.js';

export type GrantResourceType = 'agent' | 'memory_namespace';

export type Grant = {
  id: string;
  resourceType: GrantResourceType;
  resourceId: string;
  ownerId: string;
  granteeId: string;
  createdAt: string;
};

type GrantRow = {
  id: string;
  resource_type: string;
  resource_id: string;
  owner_id: string;
  grantee_id: string;
  created_at: string;
};

function toGrant(row: GrantRow): Grant {
  return {
    id: row.id,
    resourceType: row.resource_type as GrantResourceType,
    resourceId: row.resource_id,
    ownerId: row.owner_id,
    granteeId: row.grantee_id,
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

  grant(resourceType: GrantResourceType, resourceId: string, ownerId: string, granteeId: string): Grant {
    if (granteeId === ownerId) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        'Cannot share a resource with its own owner.',
        'Pick a different granteeId.'
      );
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO resource_grants (id, resource_type, resource_id, owner_id, grantee_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (resource_type, resource_id, owner_id, grantee_id) DO NOTHING`
      )
      .run(newId('grant'), resourceType, resourceId, ownerId, granteeId, now);

    const row = this.db
      .prepare(
        `SELECT * FROM resource_grants WHERE resource_type = ? AND resource_id = ? AND owner_id = ? AND grantee_id = ?`
      )
      .get(resourceType, resourceId, ownerId, granteeId) as GrantRow;
    return toGrant(row);
  }

  revoke(resourceType: GrantResourceType, resourceId: string, ownerId: string, granteeId: string): boolean {
    return (
      this.db
        .prepare(
          `DELETE FROM resource_grants WHERE resource_type = ? AND resource_id = ? AND owner_id = ? AND grantee_id = ?`
        )
        .run(resourceType, resourceId, ownerId, granteeId).changes > 0
    );
  }

  /** Whether `granteeId` has specifically been granted this resource by this owner. */
  hasGrant(resourceType: GrantResourceType, resourceId: string, ownerId: string, granteeId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM resource_grants WHERE resource_type = ? AND resource_id = ? AND owner_id = ? AND grantee_id = ?`
        )
        .get(resourceType, resourceId, ownerId, granteeId) !== undefined
    );
  }

  /** Every grantee a resource has been shared with, for its owner to review or revoke. */
  listGrantees(resourceType: GrantResourceType, resourceId: string, ownerId: string): Grant[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM resource_grants WHERE resource_type = ? AND resource_id = ? AND owner_id = ? ORDER BY created_at ASC`
        )
        .all(resourceType, resourceId, ownerId) as GrantRow[]
    ).map(toGrant);
  }

  /**
   * Every resource id of this type granted to `granteeId`, regardless of
   * owner. Used to widen a list/find query — safe for agents, where a
   * resource id already identifies exactly one owner; callers with
   * per-owner-ambiguous resource ids (e.g. a memory namespace name) must
   * disambiguate with `hasGrant` instead of relying on this alone.
   */
  listGrantedResourceIds(resourceType: GrantResourceType, granteeId: string): string[] {
    return (
      this.db
        .prepare(`SELECT DISTINCT resource_id FROM resource_grants WHERE resource_type = ? AND grantee_id = ?`)
        .all(resourceType, granteeId) as { resource_id: string }[]
    ).map(r => r.resource_id);
  }
}
