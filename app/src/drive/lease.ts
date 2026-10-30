// Which Mac keeps a show's Google Sheet and deck up to date: one at a time. When every Mac with the show open pushed
// every change, fifteen people meant fifteen pushes of each edit, getting in each other's way and over Google's quota.
// The Mac that syncs holds a lease in the show folder's Drive properties, "<until>|<mac>|<writes>|<email>|<name>",
// renewed while it has the show open; once it lapses (the Mac quit, slept or went offline) the next Mac to look takes it.
// Drive can't set a property only if it's unchanged, so a Mac that takes the lease reads it back a moment later: of two
// that took it at once, only the one whose write stuck goes on. A holder whose account can't write the Sheet's locked
// columns yet (`writes` "0") keeps trying, but any Mac that can takes the lease from it.
import { fitProperty, getFile, patchFile, pause } from "./api";

const KEY = "sync_lease";
export const LEASE_MS = 90 * 1000;
const SETTLE_MS = 2000;

export interface Lease { until: number; mac: string; writes: boolean; email: string; name: string }

/** This run of the app: the same person on two Macs is two holders. */
export const THIS_MAC = Math.random().toString(36).slice(2, 10);

/** The lease in a folder's properties, if there's one. */
export function leaseIn(properties: Record<string, string> | undefined): Lease | null {
  const v = properties?.[KEY];
  if (!v) return null;
  const [until, mac, writes, email, ...name] = v.split("|");
  return { until: Number(until), mac, writes: writes !== "0", email, name: name.join("|") || email };
}

export function leaseValue(email: string, name: string, writes: boolean, now = Date.now()): string {
  return fitProperty(KEY, `${now + LEASE_MS}|${THIS_MAC}|${writes ? 1 : 0}|${email}|${name}`);
}

/** Whether this Mac may take (or keep) `lease`: it's this Mac's, nobody's, lapsed, or held by a Mac that can't write the Sheet when this one can. */
export function mayHold(lease: Lease | null, writes: boolean, now = Date.now()): boolean {
  return !lease || lease.mac === THIS_MAC || !(lease.until > now) || (writes && !lease.writes);
}

/** Take or renew the lease if this Mac may: returns who holds it now (this Mac or another). */
export async function holdLease(folderId: string, email: string, name: string, writes: boolean): Promise<Lease | null> {
  const before = leaseIn((await getFile(folderId, "properties")).properties);
  if (!mayHold(before, writes)) return before;
  const value = leaseValue(email, name, writes);
  await patchFile(folderId, { properties: { [KEY]: value } });
  if (before?.mac === THIS_MAC && before.until > Date.now()) return leaseIn({ [KEY]: value }); // a renewal: nobody takes a lease that hasn't lapsed
  await pause(SETTLE_MS);
  return leaseIn((await getFile(folderId, "properties")).properties);
}

/** Give up the lease, if this Mac holds it, so another Mac takes over straight away. */
export async function releaseLease(folderId: string): Promise<void> {
  if (leaseIn((await getFile(folderId, "properties")).properties)?.mac !== THIS_MAC) return;
  await patchFile(folderId, { properties: { [KEY]: null } });
}
