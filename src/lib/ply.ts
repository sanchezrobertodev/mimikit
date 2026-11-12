// Whether a PLY is a mesh or a point cloud, from its header (ASCII even in binary files). The geometry can't tell:
// PLYLoader drops the index of meshes with per-face colours or UVs, so a missing index doesn't mean no faces.

/** True when the PLY in `data` declares at least one face. */
export function plyHasFaces(data: ArrayBuffer): boolean {
  // shortcut: reads the first 64 KB, so a header longer than that (pages of comments) counts as a point cloud.
  const header = new TextDecoder().decode(data.slice(0, 65536)).split("end_header")[0];
  return /^element[ \t]+face[ \t]+0*[1-9]/m.test(header);
}
