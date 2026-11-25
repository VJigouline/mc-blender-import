// Reads Blender meshes into plain arrays. Blender has stored meshes in three ways:
// - up to 3.4: structs (MVert, MPoly, MLoop, MLoopUV; MFace before 2.63) in CustomData layers;
// - 3.5 to 4.x: named generic attributes (position, .corner_vert, material_index, UV maps) in
//   CustomData layers;
// - 5.0 on: the same named attributes in the mesh's AttributeStorage.
// All three are read into one list of attributes per domain, then into faces.

import { BStruct, pointerArray, type BlendFile } from './blend-file.js';

export type Domain = 'point' | 'edge' | 'face' | 'corner';

export interface BlendMeshData {
  name: string;
  /** x, y, z per vertex, in the mesh's own space (Z up). */
  positions: Float32Array;
  /** Where each face's corners start, with the corner count at the end (faces + 1 entries). */
  faceOffsets: Uint32Array;
  /** The vertex of each corner. */
  cornerVerts: Uint32Array;
  /** Material slot of each face; null if every face uses the first slot. */
  materialIndex: Int32Array | null;
  /** 1 for faces shaded smooth; null if every face is flat. */
  smooth: Uint8Array | null;
  /** Auto smooth angle in radians, for files before Blender 4.1 that turn it on; null otherwise. */
  autoSmoothAngle: number | null;
  /** UV maps, u and v per corner; the one used for rendering first. */
  uvs: { name: string; data: Float32Array }[];
  /** A colour attribute, r, g, b, a per corner, linear; null if the mesh has none. */
  colors: { name: string; data: Float32Array } | null;
  /** Addresses of the mesh's materials, by slot. */
  materials: bigint[];
  /** Edges that belong to no face, as vertex pairs. */
  looseEdges: Uint32Array | null;
}

/** A per-domain attribute read from any of the three storage styles. */
interface Attr {
  name: string;
  domain: Domain;
  /** float, float2, float3, float4, int, int2, bool, byte4, or a struct name for legacy layers. */
  kind: string;
  count: number;
  /** Byte offset in the file and stride. */
  offset: number;
  stride: number;
  /** For legacy struct layers. */
  struct?: BStruct;
}

// CustomData layer types (eCustomDataType) that the reader needs.
const CD: Record<number, string> = { 10: 'float', 11: 'int', 17: 'byte4', 45: 'int8', 47: 'float4', 48: 'float3', 49: 'float2', 50: 'bool', 53: 'int2' };
// AttributeStorage data types (blender::bke::AttrType) by number, as far as they are needed.
const ATTR: Record<number, string> = { 0: 'bool', 1: 'int8', 3: 'int', 4: 'int2', 5: 'float', 6: 'float2', 7: 'float3' };
const DOMAINS: Domain[] = ['point', 'edge', 'face', 'corner'];

function cString(file: BlendFile, address: bigint, from?: BStruct): string {
  const found = file.blockAt(address, from?.block);
  if (!found) return '';
  let end = found.offset;
  const limit = found.block.offset + found.block.length;
  while (end < limit && file.bytes[end] !== 0) end++;
  return new TextDecoder().decode(file.bytes.subarray(found.offset, end));
}

function kindBySize(size: number, hint: string | undefined): string {
  if (hint) return hint;
  return size === 12 ? 'float3' : size === 8 ? 'float2' : size === 16 ? 'float4' : size === 1 ? 'bool' : size === 4 ? 'int' : `bytes${size}`;
}

function readAttributes(file: BlendFile, me: BStruct, counts: Record<Domain, number>): Attr[] {
  const attrs: Attr[] = [];
  // CustomData layers.
  const containers: [Domain, string[]][] = [
    ['point', ['vdata', 'vert_data']],
    ['edge', ['edata', 'edge_data']],
    ['face', ['pdata', 'face_data']],
    ['corner', ['ldata', 'corner_data']],
  ];
  const layerType = file.struct('CustomDataLayer');
  for (const [domain, names] of containers) {
    const cd = me.sub(...names);
    if (!cd || !layerType) continue;
    const total = cd.num('totlayer') ?? 0;
    const layers = file.blockAt(cd.ptr('layers'), cd.block);
    if (!layers) continue;
    for (let i = 0; i < total; i++) {
      const layer = new BStruct(file, layerType, layers.offset + i * layerType.size, layers.block);
      const data = file.blockAt(layer.ptr('data'), layer.block);
      const count = counts[domain];
      if (!data || count === 0) continue;
      const struct = file.blockStruct(data.block);
      const stride = Math.floor(data.block.length / count);
      const legacy = struct && ['MVert', 'MEdge', 'MPoly', 'MLoop', 'MLoopUV', 'MLoopCol', 'MPropCol', 'MTexPoly'].includes(struct.name);
      attrs.push({
        name: layer.str('name') ?? '',
        domain,
        kind: legacy ? struct!.name : kindBySize(stride, CD[layer.num('type') ?? -1]),
        count,
        offset: data.offset,
        stride: legacy ? struct!.size : stride,
        ...(legacy ? { struct: new BStruct(file, struct!, data.offset, data.block) } : {}),
      });
    }
  }
  // AttributeStorage (Blender 5.0 and later).
  const storage = me.sub('attribute_storage');
  const attrType = file.struct('Attribute');
  if (storage && attrType) {
    const n = storage.num('dna_attributes_num') ?? 0;
    const list = file.blockAt(storage.ptr('dna_attributes'), storage.block);
    for (let i = 0; list && i < n; i++) {
      const a = new BStruct(file, attrType, list.offset + i * attrType.size, list.block);
      const domain = DOMAINS[a.num('domain') ?? -1];
      if (!domain) continue;
      const count = counts[domain];
      const single = a.num('storage_type') === 1;
      const holder = a.deref('data', single ? 'AttributeSingle' : 'AttributeArray');
      const data = holder ? file.blockAt(holder.ptr('data'), holder.block) : null;
      if (!data || count === 0) continue;
      // A single value applies to every element.
      const stride = single ? 0 : Math.floor(data.block.length / count);
      attrs.push({ name: cString(file, a.ptr('name'), a), domain, kind: kindBySize(single ? data.block.length : stride, ATTR[a.num('data_type') ?? -1]), count, offset: data.offset, stride });
    }
  }
  return attrs;
}

function floats(file: BlendFile, a: Attr, components: number): Float32Array {
  const out = new Float32Array(a.count * components);
  const le = file.littleEndian;
  for (let i = 0; i < a.count; i++) for (let k = 0; k < components; k++) out[i * components + k] = file.view.getFloat32(a.offset + i * a.stride + 4 * k, le);
  return out;
}

function ints(file: BlendFile, a: Attr): Int32Array {
  const out = new Int32Array(a.count);
  const le = file.littleEndian;
  for (let i = 0; i < a.count; i++) out[i] = a.kind === 'int8' ? file.view.getInt8(a.offset + i * a.stride) : file.view.getInt32(a.offset + i * a.stride, le);
  return out;
}

function bools(file: BlendFile, a: Attr): Uint8Array {
  const out = new Uint8Array(a.count);
  for (let i = 0; i < a.count; i++) out[i] = file.bytes[a.offset + i * a.stride]! ? 1 : 0;
  return out;
}

/** Reads a field of every struct in a legacy layer. */
function structField(a: Attr, field: string): number[][] {
  const out: number[][] = [];
  const s = a.struct!;
  const type = s.type;
  for (let i = 0; i < a.count; i++) {
    const item = new BStruct(s.file, type, a.offset + i * type.size, s.block);
    out.push(item.nums(field) ?? []);
  }
  return out;
}

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

export class BlendMeshError extends Error {
  override name = 'BlendMeshError';
}

/** Reads a Mesh struct. Returns null for a mesh without vertices. */
export function readMesh(file: BlendFile, me: BStruct, warnings: string[]): BlendMeshData | null {
  const name = me.idName;
  const counts: Record<Domain, number> = {
    point: me.num('totvert', 'verts_num') ?? 0,
    edge: me.num('totedge', 'edges_num') ?? 0,
    face: me.num('totpoly', 'faces_num') ?? 0,
    corner: me.num('totloop', 'corners_num') ?? 0,
  };
  if (!counts.point) return null;
  const attrs = readAttributes(file, me, counts);
  const find = (domain: Domain, test: (a: Attr) => boolean) => attrs.find((a) => a.domain === domain && test(a));

  // Positions.
  let positions: Float32Array | null = null;
  const mvert = find('point', (a) => a.kind === 'MVert');
  const position = find('point', (a) => a.name === 'position' && a.kind === 'float3');
  if (position) positions = floats(file, position, 3);
  else if (mvert) positions = Float32Array.from(structField(mvert, 'co').flat());
  if (!positions) throw new BlendMeshError(`Mesh ${name} has no vertex positions`);

  // Faces.
  let faceOffsets: Uint32Array;
  let cornerVerts: Uint32Array;
  let materialIndex: Int32Array | null = null;
  let smooth: Uint8Array | null = null;
  const uvs: { name: string; data: Float32Array }[] = [];
  const mpoly = find('face', (a) => a.kind === 'MPoly');
  const mloop = find('corner', (a) => a.kind === 'MLoop');
  const totface = me.num('totface') ?? 0;
  if (counts.face > 0) {
    faceOffsets = new Uint32Array(counts.face + 1);
    if (mpoly) {
      const starts = structField(mpoly, 'loopstart');
      const sizes = structField(mpoly, 'totloop');
      // Polys are usually in corner order; rebuild the corner list in face order to be sure.
      const order: number[] = [];
      for (let f = 0; f < counts.face; f++) {
        faceOffsets[f] = order.length;
        for (let k = 0; k < sizes[f]![0]!; k++) order.push(starts[f]![0]! + k);
      }
      faceOffsets[counts.face] = order.length;
      const loopVerts = mloop ? structField(mloop, 'v').map((v) => v[0]!) : [];
      const cornerVert = find('corner', (a) => a.name === '.corner_vert');
      const verts = mloop ? loopVerts : cornerVert ? Array.from(ints(file, cornerVert)) : [];
      cornerVerts = Uint32Array.from(order, (c) => verts[c] ?? 0);
      const mat = structField(mpoly, 'mat_nr').map((v) => v[0]!);
      if (mat.some((m) => m !== 0)) materialIndex = Int32Array.from(mat);
      const flags = structField(mpoly, 'flag').map((v) => v[0]!);
      if (flags.some((f) => f & 1)) smooth = Uint8Array.from(flags, (f) => f & 1);
      // UVs in the same corner order.
      for (const a of attrs.filter((x) => x.domain === 'corner' && (x.kind === 'MLoopUV' || (x.kind === 'float2' && !x.name.startsWith('.'))))) {
        const raw = a.kind === 'MLoopUV' ? Float32Array.from(structField(a, 'uv').flat()) : floats(file, a, 2);
        uvs.push({ name: a.name, data: Float32Array.from(order.flatMap((c) => [raw[c * 2]!, raw[c * 2 + 1]!])) });
      }
    } else {
      const offsets = file.blockAt(me.ptr('poly_offset_indices', 'face_offset_indices'), me.block);
      if (!offsets) throw new BlendMeshError(`Mesh ${name} has faces but no face offsets`);
      for (let f = 0; f <= counts.face; f++) faceOffsets[f] = file.view.getInt32(offsets.offset + 4 * f, file.littleEndian);
      const cornerVert = find('corner', (a) => a.name === '.corner_vert');
      if (!cornerVert) throw new BlendMeshError(`Mesh ${name} has no corner vertices`);
      cornerVerts = Uint32Array.from(ints(file, cornerVert));
      const mat = find('face', (a) => a.name === 'material_index');
      if (mat) materialIndex = ints(file, mat);
      const sharp = find('face', (a) => a.name === 'sharp_face');
      if (sharp) {
        const s = bools(file, sharp);
        smooth = Uint8Array.from(s, (v) => (v ? 0 : 1));
      } else {
        // Without sharp_face, every face is smooth (Blender 4.1 and later write it only when some are flat).
        smooth = new Uint8Array(counts.face).fill(file.version >= 401 ? 1 : 0);
      }
      for (const a of attrs.filter((x) => x.domain === 'corner' && (x.kind === 'float2' || x.kind === 'MLoopUV') && !x.name.startsWith('.'))) {
        uvs.push({ name: a.name, data: a.kind === 'MLoopUV' ? Float32Array.from(structField(a, 'uv').flat()) : floats(file, a, 2) });
      }
    }
  } else if (totface > 0) {
    // Before Blender 2.63: MFace tessellated faces of 3 or 4 vertices, with MTFace UVs.
    const mface = file.blockAt(me.ptr('mface'), me.block);
    const type = file.struct('MFace');
    if (!mface || !type) throw new BlendMeshError(`Mesh ${name} has no faces it can read`);
    const offsets: number[] = [0];
    const verts: number[] = [];
    const mats: number[] = [];
    const flags: number[] = [];
    for (let f = 0; f < totface; f++) {
      const s = new BStruct(file, type, mface.offset + f * type.size, mface.block);
      const v = [s.num('v1')!, s.num('v2')!, s.num('v3')!, s.num('v4')!];
      const n = v[3] ? 4 : 3;
      verts.push(...v.slice(0, n));
      offsets.push(verts.length);
      mats.push(s.num('mat_nr') ?? 0);
      flags.push(s.num('flag') ?? 0);
    }
    faceOffsets = Uint32Array.from(offsets);
    cornerVerts = Uint32Array.from(verts);
    if (mats.some((m) => m)) materialIndex = Int32Array.from(mats);
    if (flags.some((f) => f & 1)) smooth = Uint8Array.from(flags, (f) => f & 1);
    const mtface = file.blockAt(me.ptr('mtface'), me.block);
    const tfType = file.struct('MTFace');
    if (mtface && tfType) {
      const data: number[] = [];
      for (let f = 0; f < totface; f++) {
        const s = new BStruct(file, tfType, mtface.offset + f * tfType.size, mtface.block);
        const uv = s.nums('uv') ?? [];
        const n = offsets[f + 1]! - offsets[f]!;
        for (let k = 0; k < n; k++) data.push(uv[k * 2] ?? 0, uv[k * 2 + 1] ?? 0);
      }
      uvs.push({ name: 'UVMap', data: Float32Array.from(data) });
    }
  } else {
    faceOffsets = new Uint32Array([0]);
    cornerVerts = new Uint32Array(0);
  }

  // The UV map used for rendering goes first.
  const active = cString(file, me.ptr('default_uv_map_attribute'), me) || cString(file, me.ptr('active_uv_map_attribute'), me);
  if (active) uvs.sort((a, b) => (a.name === active ? -1 : b.name === active ? 1 : 0));

  // A colour attribute: the default one, or else the first on points or corners.
  let colors: BlendMeshData['colors'] = null;
  const colorName = cString(file, me.ptr('default_color_attribute'), me) || cString(file, me.ptr('active_color_attribute'), me);
  const colorAttr =
    attrs.find((a) => !!colorName && a.name === colorName && (a.domain === 'point' || a.domain === 'corner')) ??
    attrs.find((a) => (a.domain === 'point' || a.domain === 'corner') && !a.name.startsWith('.') && ['float4', 'byte4', 'MLoopCol', 'MPropCol'].includes(a.kind));
  if (colorAttr && ['float4', 'byte4', 'MLoopCol', 'MPropCol'].includes(colorAttr.kind) && faceOffsets[faceOffsets.length - 1]! > 0) {
    const n = colorAttr.count;
    const raw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 4; k++) {
        if (colorAttr.kind === 'byte4' || colorAttr.kind === 'MLoopCol') {
          // Byte colours are stored in sRGB.
          const b = file.bytes[colorAttr.offset + i * colorAttr.stride + k]! / 255;
          raw[i * 4 + k] = k < 3 ? srgbToLinear(b) : b;
        } else {
          raw[i * 4 + k] = file.view.getFloat32(colorAttr.offset + i * colorAttr.stride + 4 * k, file.littleEndian);
        }
      }
    }
    const corners = cornerVerts.length;
    const data = new Float32Array(corners * 4);
    for (let c = 0; c < corners; c++) {
      const src = colorAttr.domain === 'point' ? cornerVerts[c]! : c;
      data.set(raw.subarray(src * 4, src * 4 + 4), c * 4);
    }
    colors = { name: colorAttr.name, data };
  }

  // Edges outside faces, drawn as lines.
  let looseEdges: Uint32Array | null = null;
  if (counts.edge > 0) {
    const pairs: number[] = [];
    const medge = find('edge', (a) => a.kind === 'MEdge');
    const edgeVerts = find('edge', (a) => a.name === '.edge_verts');
    if (medge) {
      const v1 = structField(medge, 'v1');
      const v2 = structField(medge, 'v2');
      for (let e = 0; e < v1.length; e++) pairs.push(v1[e]![0]!, v2[e]![0]!);
    } else if (edgeVerts) {
      const le = file.littleEndian;
      for (let e = 0; e < edgeVerts.count; e++) {
        const at = edgeVerts.offset + e * edgeVerts.stride;
        pairs.push(file.view.getInt32(at, le), file.view.getInt32(at + 4, le));
      }
    }
    if (pairs.length) {
      const inFaces = new Set<string>();
      for (let f = 0; f + 1 < faceOffsets.length; f++) {
        const s = faceOffsets[f]!;
        const e = faceOffsets[f + 1]!;
        for (let c = s; c < e; c++) {
          const a = cornerVerts[c]!;
          const b = cornerVerts[c + 1 < e ? c + 1 : s]!;
          inFaces.add(a < b ? `${a},${b}` : `${b},${a}`);
        }
      }
      const loose: number[] = [];
      for (let i = 0; i < pairs.length; i += 2) {
        const a = pairs[i]!;
        const b = pairs[i + 1]!;
        if (!inFaces.has(a < b ? `${a},${b}` : `${b},${a}`)) loose.push(a, b);
      }
      if (loose.length) looseEdges = Uint32Array.from(loose);
    }
  }

  // Auto smooth (until Blender 4.1).
  const ME_AUTOSMOOTH = 1 << 5;
  const autoSmoothAngle = file.version < 401 && ((me.num('flag') ?? 0) & ME_AUTOSMOOTH) ? (me.num('smoothresh') ?? Math.PI / 6) : null;

  const totcol = me.num('totcol') ?? 0;
  const materials = totcol > 0 ? pointerArray(file, me.ptr('mat'), totcol, me.block) : [];
  if (me.ptr('key') !== 0n) warnings.push(`Mesh ${name}: shape keys are not read; the basis shape is used`);
  return { name, positions, faceOffsets, cornerVerts, materialIndex, smooth, autoSmoothAngle, uvs, colors, materials, looseEdges };
}
