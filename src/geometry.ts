// Turns a Blender mesh into a three.js BufferGeometry: faces are triangulated (fans for convex
// faces, ear clipping for others), every face corner becomes a vertex, and normals follow the
// face's shading: the face normal for flat faces, and an angle-weighted vertex normal for smooth
// ones, split by the auto smooth angle where a file uses it.

import * as THREE from 'three';
import type { BlendMeshData } from './mesh.js';

export interface GeometryResult {
  geometry: THREE.BufferGeometry;
  /** Material slot of each geometry group, in group order. */
  slots: number[];
  triangles: number;
}

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};

/** Triangulates one face, returning corner indices relative to the face's first corner. */
function triangulate(points: V3[], normal: V3): number[] {
  const n = points.length;
  if (n < 3) return [];
  if (n === 3) return [0, 1, 2];
  if (n === 4) {
    // Split along the shorter diagonal, as Blender does.
    const d02 = Math.hypot(...sub(points[0]!, points[2]!));
    const d13 = Math.hypot(...sub(points[1]!, points[3]!));
    return d02 <= d13 ? [0, 1, 2, 0, 2, 3] : [0, 1, 3, 1, 2, 3];
  }
  // Project onto the face plane and ear-clip.
  const u = norm(Math.abs(normal[0]) < 0.9 ? cross(normal, [1, 0, 0]) : cross(normal, [0, 1, 0]));
  const v = cross(normal, u);
  const contour = points.map((p) => new THREE.Vector2(dot(p, u), dot(p, v)));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  if (!tris.length) {
    const fan: number[] = [];
    for (let i = 1; i + 1 < n; i++) fan.push(0, i, i + 1);
    return fan;
  }
  // Keep the face's winding.
  const out: number[] = [];
  const ccw = !THREE.ShapeUtils.isClockWise(contour);
  for (const [a, b, c] of tris) out.push(...(ccw ? [a!, b!, c!] : [a!, c!, b!]));
  return out;
}

export function buildGeometry(mesh: BlendMeshData): GeometryResult | null {
  const { positions, faceOffsets, cornerVerts } = mesh;
  const faces = faceOffsets.length - 1;
  if (faces <= 0) return null;
  const vertex = (i: number): V3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];

  // Face normals (Newell's method) and triangles.
  const faceNormals: V3[] = [];
  const faceTris: number[][] = [];
  for (let f = 0; f < faces; f++) {
    const s = faceOffsets[f]!;
    const e = faceOffsets[f + 1]!;
    const pts: V3[] = [];
    for (let c = s; c < e; c++) pts.push(vertex(cornerVerts[c]!));
    const n: V3 = [0, 0, 0];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const fn = norm(n);
    faceNormals.push(fn);
    faceTris.push(triangulate(pts, fn));
  }

  // Corner normals.
  const corners = cornerVerts.length;
  const normals = new Float32Array(corners * 3);
  const smooth = mesh.smooth;
  // Angle-weighted contributions of smooth faces at each vertex.
  const contributions = new Map<number, { face: number; n: V3; w: number }[]>();
  if (smooth) {
    for (let f = 0; f < faces; f++) {
      if (!smooth[f]) continue;
      const s = faceOffsets[f]!;
      const e = faceOffsets[f + 1]!;
      const k = e - s;
      for (let c = s; c < e; c++) {
        const p = vertex(cornerVerts[c]!);
        const prev = vertex(cornerVerts[c === s ? e - 1 : c - 1]!);
        const next = vertex(cornerVerts[c + 1 === e ? s : c + 1]!);
        const a = norm(sub(prev, p));
        const b = norm(sub(next, p));
        const w = k > 2 ? Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) : 1;
        const list = contributions.get(cornerVerts[c]!) ?? [];
        list.push({ face: f, n: faceNormals[f]!, w });
        contributions.set(cornerVerts[c]!, list);
      }
    }
  }
  const cosLimit = mesh.autoSmoothAngle !== null ? Math.cos(mesh.autoSmoothAngle) : -2;
  for (let f = 0; f < faces; f++) {
    const fn = faceNormals[f]!;
    for (let c = faceOffsets[f]!; c < faceOffsets[f + 1]!; c++) {
      let n = fn;
      if (smooth?.[f]) {
        const sum: V3 = [0, 0, 0];
        for (const k of contributions.get(cornerVerts[c]!) ?? []) {
          if (k.face !== f && dot(k.n, fn) < cosLimit) continue;
          sum[0] += k.n[0] * k.w;
          sum[1] += k.n[1] * k.w;
          sum[2] += k.n[2] * k.w;
        }
        n = norm(sum);
      }
      normals.set(n, c * 3);
    }
  }

  // Corner positions.
  const pos = new Float32Array(corners * 3);
  for (let c = 0; c < corners; c++) pos.set(positions.subarray(cornerVerts[c]! * 3, cornerVerts[c]! * 3 + 3), c * 3);

  // Triangles grouped by material slot.
  const bySlot = new Map<number, number[]>();
  let triangles = 0;
  for (let f = 0; f < faces; f++) {
    const slot = mesh.materialIndex ? Math.max(0, mesh.materialIndex[f]!) : 0;
    const list = bySlot.get(slot) ?? [];
    const s = faceOffsets[f]!;
    for (const i of faceTris[f]!) list.push(s + i);
    triangles += faceTris[f]!.length / 3;
    bySlot.set(slot, list);
  }
  const slots = [...bySlot.keys()].sort((a, b) => a - b);
  const index: number[] = [];
  const geometry = new THREE.BufferGeometry();
  for (const slot of slots) {
    const list = bySlot.get(slot)!;
    geometry.addGroup(index.length, list.length, slots.indexOf(slot));
    for (const i of list) index.push(i);
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  mesh.uvs.slice(0, 4).forEach((uv, i) => geometry.setAttribute(i === 0 ? 'uv' : `uv${i}`, new THREE.BufferAttribute(uv.data, 2)));
  if (mesh.colors) geometry.setAttribute('color', new THREE.BufferAttribute(mesh.colors.data, 4));
  geometry.setIndex(corners > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return { geometry, slots, triangles };
}
