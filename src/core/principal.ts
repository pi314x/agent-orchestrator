/**
 * Who a request is acting as. Derived once per serving unit from the verified
 * token, never from anything the caller can set directly.
 *
 * `''` is the single-owner deployment: with OAuth unconfigured there is no
 * caller identity at all, so everything belongs to one owner and the
 * orchestrator behaves exactly as it did before ownership existed. That is the
 * right default for a loopback server and the wrong one for a shared host,
 * which is why `ORCH_OAUTH_ISSUER_URL` is what turns isolation on.
 */
export const SINGLE_OWNER = '';

export type Principal = {
  /** Owns the rows this caller creates. */
  ownerId: string;
  /** Admins read and act across owners; everyone else is confined to their own. */
  isAdmin: boolean;
};

export const SINGLE_USER_PRINCIPAL: Principal = { ownerId: SINGLE_OWNER, isAdmin: true };

/**
 * Spread into a store filter to confine a listing to the caller. Admins get an
 * empty object and therefore see every owner.
 */
export function ownerFilter(principal: Principal): { ownerId?: string } {
  return principal.isAdmin ? {} : { ownerId: principal.ownerId };
}
