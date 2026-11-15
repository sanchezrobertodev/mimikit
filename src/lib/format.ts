// Path helpers, with no imports so the Node tests can use them. Display formatting is in fmt.ts.

/** Folder part of a "/"-separated relative path. */
export function folderOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * A library folder's name. When another library folder has the same name, the nearest parent folder that tells them
 * apart follows it: "files · assets" and "files · audio".
 */
/**
 * "/"-separated paths without the leading folders they all share, so what tells them apart shows: "lib/a/" and
 * "lib/b/x.png" give "a/" and "b/x.png". Each keeps at least its last part.
 */
export function differingParts(paths: string[]): string[] {
  const parts = paths.map((p) => p.match(/[^/]*\/|[^/]+$/g) ?? [p]);
  const most = Math.min(...parts.map((p) => p.length)) - 1;
  let n = 0;
  while (n < most && parts.every((p) => p[n] === parts[0][n])) n++;
  return parts.map((p) => p.slice(n).join(""));
}

export function rootLabel(roots: { id: number; path: string }[], id: number): string {
  const parts = (path: string) => path.split(/[\\/]/).filter(Boolean);
  const own = parts(roots.find((r) => r.id === id)?.path ?? "");
  const name = own.at(-1) ?? "";
  const twins = roots.filter((r) => r.id !== id && parts(r.path).at(-1) === name).map((r) => parts(r.path));
  for (let up = 2; twins.length && up <= own.length; up++) if (twins.every((p) => p.at(-up) !== own.at(-up))) return `${name} · ${own.at(-up)}`;
  return name;
}
