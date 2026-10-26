// Field-by-field merge of two people's edits to a show. `base` is the show as last agreed with Drive, `local` is this
// Mac's copy and `remote` the one just downloaded. What only one side changed is kept; where both changed the same
// value differently, this Mac's wins and the place is reported, so the user can be told.
//
// Objects merge key by key. Lists of things with an `id` (records, columns, notes…) or a `path` (clips) merge item by
// item, and lists of ids or paths (set_order, gallery…) merge as ordered lists: deletes and inserts from both sides
// survive, and an order changed on one side only is kept. Any other list (colours, TC blocks) is one value.

type Json = unknown;
export interface MergeConflict {
  path: (string | number)[];
  local: Json;
  remote: Json;
}

const isObject = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

export function same(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!same(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** The key an item of a list is matched by across versions, if every item has one. */
function keyOf(list: Json[]): ((item: Json) => string) | null {
  if (!list.length) return null;
  for (const field of ["id", "path"]) {
    if (list.every((x) => isObject(x) && typeof x[field] === "string")) return (x) => (x as Record<string, string>)[field];
  }
  return null;
}

const unique = (list: string[]) => new Set(list).size === list.length;

/** The order of `items` that are also in `among`. */
const orderOf = (items: string[], among: Set<string>) => items.filter((x) => among.has(x));

/** `primary` with `secondary`'s deletes and inserts (relative to `base`) applied. */
function applyChanges(primary: string[], base: string[], secondary: string[]): string[] {
  const inBase = new Set(base);
  const inSecondary = new Set(secondary);
  const out = primary.filter((x) => !(inBase.has(x) && !inSecondary.has(x)));
  const present = new Set(out);
  secondary.forEach((x, i) => {
    if (inBase.has(x) || present.has(x)) return;
    // after the nearest item before it (in `secondary`) that's in the result; at the start if none is
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(secondary[j]);
      if (k >= 0) { at = k + 1; break; }
    }
    out.splice(at, 0, x);
    present.add(x);
  });
  return out;
}

/** Merge ordered lists of distinct strings (ids, paths). */
export function mergeList(base: string[], local: string[], remote: string[]): string[] {
  const common = new Set(base.filter((x) => local.includes(x) && remote.includes(x)));
  const baseOrder = orderOf(base, common);
  const localMoved = !same(orderOf(local, common), baseOrder);
  const remoteMoved = !same(orderOf(remote, common), baseOrder);
  // An order changed only here is kept; otherwise the remote order is the starting point.
  return localMoved && !remoteMoved ? applyChanges(local, base, remote) : applyChanges(remote, base, local);
}

function mergeKeyed(base: Json[], local: Json[], remote: Json[], key: (x: Json) => string, path: (string | number)[], conflicts: MergeConflict[]): Json[] {
  const map = (list: Json[]) => new Map(list.map((x) => [key(x), x]));
  const [b, l, r] = [map(base), map(local), map(remote)];
  const order = mergeList([...b.keys()], [...l.keys()], [...r.keys()]);
  const out: Json[] = [];
  for (const k of new Set([...order, ...l.keys(), ...r.keys()])) {
    const merged = mergeValue(b.get(k), l.get(k), r.get(k), [...path, k], conflicts);
    if (merged !== undefined) out.push(merged);
  }
  return out;
}

function mergeValue(base: Json, local: Json, remote: Json, path: (string | number)[], conflicts: MergeConflict[]): Json {
  if (same(local, remote)) return local;
  if (same(base, local)) return remote;
  if (same(base, remote)) return local;

  if (isObject(local) && isObject(remote)) {
    const b = isObject(base) ? base : {};
    const out: Record<string, Json> = {};
    for (const k of new Set([...Object.keys(remote), ...Object.keys(local)])) {
      const merged = mergeValue(b[k], local[k], remote[k], [...path, k], conflicts);
      if (merged !== undefined) out[k] = merged;
    }
    return out;
  }
  if (Array.isArray(local) && Array.isArray(remote)) {
    const b = Array.isArray(base) ? base : [];
    const all = [...b, ...local, ...remote];
    if (all.every((x) => typeof x === "string") && unique(b as string[]) && unique(local as string[]) && unique(remote as string[])) {
      return mergeList(b as string[], local as string[], remote as string[]);
    }
    const key = keyOf(all);
    if (key && unique(b.map(key)) && unique(local.map(key)) && unique(remote.map(key))) return mergeKeyed(b, local, remote, key, path, conflicts);
  }
  conflicts.push({ path, local, remote });
  return local;
}

/** Merge this Mac's show with the one on Drive, both changed since `base`. */
export function merge3<T>(base: T, local: T, remote: T): { merged: T; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = [];
  const merged = mergeValue(base, local, remote, [], conflicts) as T;
  return { merged, conflicts };
}
