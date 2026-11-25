// Reads the structure of a .blend file: the header, the file blocks, and SDNA, the catalogue of
// struct layouts that every .blend file carries. Structs are read by field name through SDNA, so
// the same code reads files from Blender 2.5 to 5.x, with 4- or 8-byte pointers, in either byte
// order, and with the 64-bit block headers that Blender 5 introduced.

import { decompress as zstdDecompress } from 'fzstd';

export class BlendFileError extends Error {
  override name = 'BlendFileError';
}

export interface BlendBlock {
  /** Block code, such as OB, ME, DATA or DNA1. */
  code: string;
  /** Index of the block's struct type in SDNA. */
  sdna: number;
  /** Index of the ID block this block belongs to: itself for an ID, or the ID it follows for DATA. */
  group: number;
  /** The address the data had in memory when it was saved; pointers refer to it. */
  address: bigint;
  /** Byte length of the data. */
  length: number;
  /** Number of structs in the block. */
  count: number;
  /** Where the data starts in the file. */
  offset: number;
}

export interface DnaField {
  /** The name without pointer stars or array sizes, such as co for co[3]. */
  name: string;
  type: string;
  offset: number;
  size: number;
  pointer: boolean;
  /** Product of the array sizes; 1 for a single value. */
  length: number;
  /** Array sizes, such as [4, 4] for mat[4][4]. */
  dims: number[];
}

export interface DnaStruct {
  name: string;
  size: number;
  fields: Map<string, DnaField>;
}

const BASIC_TYPES = new Set(['char', 'uchar', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'float', 'double', 'int64_t', 'uint64_t', 'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int32_t', 'uint32_t', 'bool', 'void']);

/** True if the bytes start like a zstd frame, as compressed .blend files from Blender 3.0 on do. */
export const isZstd = (b: Uint8Array) => b.length > 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;
/** True if the bytes start like gzip, as compressed .blend files before Blender 3.0 do. */
export const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

/** True if the bytes are a .blend file, compressed or not. */
export function isBlend(bytes: Uint8Array): boolean {
  return isZstd(bytes) || isGzip(bytes) || new TextDecoder().decode(bytes.subarray(0, 7)) === 'BLENDER';
}

/** Inflates zstd- or gzip-compressed .blend files; returns other bytes as they are. */
export async function decompressBlend(bytes: Uint8Array): Promise<Uint8Array> {
  if (isZstd(bytes)) return zstdDecompress(bytes);
  if (isGzip(bytes)) {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

export class BlendFile {
  readonly view: DataView;
  readonly pointerSize: 4 | 8;
  readonly littleEndian: boolean;
  /** Blender version that saved the file, such as 279 or 502. */
  readonly version: number;
  readonly blocks: BlendBlock[] = [];
  readonly structs: DnaStruct[] = [];
  private readonly structIndex = new Map<string, number>();
  private lastId = -1;
  private readonly typeSizes = new Map<string, number>();
  /** ID blocks (and other non-DATA blocks) by address. */
  private readonly ids = new Map<bigint, BlendBlock>();
  /** Every block by address, the last one written winning, for files with unique addresses. */
  private readonly byAddress = new Map<bigint, BlendBlock>();
  /** Each ID's own blocks by address: recent Blender versions reuse data addresses between IDs. */
  private readonly groups = new Map<number, Map<bigint, BlendBlock>>();
  private sorted: BlendBlock[] = [];

  constructor(readonly bytes: Uint8Array) {
    if (!isBlend(bytes) || isZstd(bytes) || isGzip(bytes)) {
      throw new BlendFileError(isZstd(bytes) || isGzip(bytes) ? 'The file is compressed; inflate it with decompressBlend first' : 'Not a .blend file');
    }
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const head = new TextDecoder().decode(bytes.subarray(0, 17));
    let offset: number;
    let large = false;
    if (/^BLENDER\d\d-\d\d[vV]\d{4}/.test(head)) {
      // Blender 5 and later: BLENDER, header size, -, file format version, endianness, version.
      const headerSize = Number(head.slice(7, 9));
      const format = Number(head.slice(10, 12));
      if (format !== 1) throw new BlendFileError(`File format version ${format} is not supported`);
      this.pointerSize = 8;
      this.littleEndian = head[12] === 'v';
      this.version = Number(head.slice(13, 17));
      large = true;
      offset = headerSize;
    } else if (/^BLENDER[_-][vV]\d{3}/.test(head)) {
      this.pointerSize = head[7] === '_' ? 4 : 8;
      this.littleEndian = head[8] === 'v';
      this.version = Number(head.slice(9, 12));
      offset = 12;
    } else {
      throw new BlendFileError(`Unknown .blend header ${JSON.stringify(head.slice(0, 12))}`);
    }
    // Blocks.
    const le = this.littleEndian;
    const v = this.view;
    while (offset + 8 <= bytes.length) {
      const code = new TextDecoder().decode(bytes.subarray(offset, offset + 4)).replace(/\0+$/, '');
      let block: BlendBlock;
      if (large) {
        block = {
          code,
          group: 0,
          sdna: v.getInt32(offset + 4, le),
          address: v.getBigUint64(offset + 8, le),
          length: Number(v.getBigInt64(offset + 16, le)),
          count: Number(v.getBigInt64(offset + 24, le)),
          offset: offset + 32,
        };
      } else if (this.pointerSize === 8) {
        block = { code, group: 0, length: v.getInt32(offset + 4, le), address: v.getBigUint64(offset + 8, le), sdna: v.getInt32(offset + 16, le), count: v.getInt32(offset + 20, le), offset: offset + 24 };
      } else {
        block = { code, group: 0, length: v.getInt32(offset + 4, le), address: BigInt(v.getUint32(offset + 8, le)), sdna: v.getInt32(offset + 12, le), count: v.getInt32(offset + 16, le), offset: offset + 20 };
      }
      if (code === 'ENDB') break;
      block.group = code === 'DATA' ? Math.max(0, this.lastId) : this.blocks.length;
      if (code !== 'DATA') this.lastId = this.blocks.length;
      if (block.length < 0 || block.offset + block.length > bytes.length) throw new BlendFileError(`Corrupt block ${code} at byte ${offset}`);
      this.blocks.push(block);
      offset = block.offset + block.length;
    }
    const dna = this.blocks.find((b) => b.code === 'DNA1');
    if (!dna) throw new BlendFileError('The file has no SDNA block');
    this.readSdna(dna);
    for (const block of this.blocks) {
      if (block.address === 0n || block.code === 'DNA1' || block.code === 'TEST' || block.code === 'REND') continue;
      this.byAddress.set(block.address, block);
      if (block.code !== 'DATA') this.ids.set(block.address, block);
      let group = this.groups.get(block.group);
      if (!group) this.groups.set(block.group, (group = new Map()));
      group.set(block.address, block);
    }
    this.sorted = [...this.byAddress.values()].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  }

  private readSdna(dna: BlendBlock): void {
    const b = this.bytes;
    const v = this.view;
    const le = this.littleEndian;
    let p = dna.offset;
    const tag = (t: string) => {
      const got = new TextDecoder().decode(b.subarray(p, p + 4));
      if (got !== t) throw new BlendFileError(`Corrupt SDNA: expected ${t}, found ${got}`);
      p += 4;
    };
    const align = () => {
      p = dna.offset + ((p - dna.offset + 3) & ~3);
    };
    const strings = (n: number) => {
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        let e = p;
        while (b[e] !== 0) e++;
        out.push(new TextDecoder().decode(b.subarray(p, e)));
        p = e + 1;
      }
      return out;
    };
    tag('SDNA');
    tag('NAME');
    const nNames = v.getInt32(p, le);
    p += 4;
    const names = strings(nNames);
    align();
    tag('TYPE');
    const nTypes = v.getInt32(p, le);
    p += 4;
    const types = strings(nTypes);
    align();
    tag('TLEN');
    const lengths: number[] = [];
    for (let i = 0; i < nTypes; i++, p += 2) lengths.push(v.getUint16(p, le));
    align();
    tag('STRC');
    const nStructs = v.getInt32(p, le);
    p += 4;
    types.forEach((t, i) => this.typeSizes.set(t, lengths[i]!));
    for (let s = 0; s < nStructs; s++) {
      const type = types[v.getUint16(p, le)]!;
      const nFields = v.getUint16(p + 2, le);
      p += 4;
      const fields = new Map<string, DnaField>();
      let off = 0;
      for (let f = 0; f < nFields; f++, p += 4) {
        const ftype = types[v.getUint16(p, le)]!;
        const fname = names[v.getUint16(p + 2, le)]!;
        const pointer = fname.startsWith('*') || fname.startsWith('(*');
        const dims = [...fname.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
        const length = dims.reduce((a, d) => a * d, 1);
        const base = fname.replace(/^\(?\*+/, '').replace(/\)\(.*$/, '').replace(/\[.*$/, '');
        const size = (pointer ? this.pointerSize : (this.typeSizes.get(ftype) ?? 0)) * length;
        if (!fields.has(base)) fields.set(base, { name: base, type: ftype, offset: off, size, pointer, length, dims });
        off += size;
      }
      this.structs.push({ name: type, size: this.typeSizes.get(type) ?? 0, fields });
      this.structIndex.set(type, s);
    }
  }

  /** The struct layout with this name, if the file has it. */
  struct(name: string): DnaStruct | undefined {
    const i = this.structIndex.get(name);
    return i === undefined ? undefined : this.structs[i];
  }

  /**
   * The block that holds this address, at its start or inside it. Pointers are resolved as
   * Blender does: among the blocks of the ID the pointer is read from (`from`), then among IDs,
   * then among all blocks.
   */
  blockAt(address: bigint, from?: BlendBlock): { block: BlendBlock; offset: number } | null {
    if (address === 0n) return null;
    const own = from ? this.groups.get(from.group)?.get(address) : undefined;
    const exact = own ?? this.ids.get(address) ?? (from && this.groups.has(from.group) && this.reusesAddresses ? undefined : this.byAddress.get(address));
    if (exact) return { block: exact, offset: exact.offset };
    if (from) {
      // Inside a block of the same ID, such as an element of an array.
      for (const block of this.groups.get(from.group)?.values() ?? []) {
        if (address > block.address && address < block.address + BigInt(block.length)) return { block, offset: block.offset + Number(address - block.address) };
      }
      if (this.reusesAddresses) return null;
    }
    let lo = 0;
    let hi = this.sorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const block = this.sorted[mid]!;
      if (address < block.address) hi = mid - 1;
      else if (address >= block.address + BigInt(block.length)) lo = mid + 1;
      else return { block, offset: block.offset + Number(address - block.address) };
    }
    return null;
  }

  /** True if data addresses repeat between IDs, as in files from recent Blender versions. */
  get reusesAddresses(): boolean {
    if (this.reuse === undefined) {
      const seen = new Set<bigint>();
      this.reuse = false;
      for (const b of this.blocks) {
        if (b.code !== 'DATA' || b.address === 0n) continue;
        if (seen.has(b.address)) {
          this.reuse = true;
          break;
        }
        seen.add(b.address);
      }
    }
    return this.reuse;
  }
  private reuse: boolean | undefined;

  /** Blocks with this code, such as OB for objects. */
  blocksWithCode(code: string): BlendBlock[] {
    return this.blocks.filter((b) => b.code === code);
  }

  /** The struct type of a block. */
  blockStruct(block: BlendBlock): DnaStruct | undefined {
    return this.structs[block.sdna];
  }

  /** A view of the first struct in a block, using the block's own struct type. */
  structOf(block: BlendBlock, index = 0): BStruct | null {
    const type = this.blockStruct(block);
    if (!type) return null;
    return new BStruct(this, type, block.offset + index * type.size, block);
  }

  /** A view of a struct of a known type at an address. */
  at(address: bigint, typeName?: string, from?: BlendBlock): BStruct | null {
    const found = this.blockAt(address, from);
    if (!found) return null;
    const type = typeName ? this.struct(typeName) : this.blockStruct(found.block);
    if (!type) return null;
    return new BStruct(this, type, found.offset, found.block);
  }

  pointer(offset: number): bigint {
    return this.pointerSize === 8 ? this.view.getBigUint64(offset, this.littleEndian) : BigInt(this.view.getUint32(offset, this.littleEndian));
  }

  typeSize(type: string): number {
    return this.typeSizes.get(type) ?? 0;
  }

  /** Reads one value of a basic type. */
  value(type: string, offset: number): number {
    const v = this.view;
    const le = this.littleEndian;
    switch (type) {
      case 'char':
      case 'int8_t':
        return v.getInt8(offset);
      case 'uchar':
      case 'uint8_t':
      case 'bool':
        return v.getUint8(offset);
      case 'short':
      case 'int16_t':
        return v.getInt16(offset, le);
      case 'ushort':
      case 'uint16_t':
        return v.getUint16(offset, le);
      case 'int':
      case 'int32_t':
        return v.getInt32(offset, le);
      case 'uint':
      case 'uint32_t':
        return v.getUint32(offset, le);
      case 'float':
        return v.getFloat32(offset, le);
      case 'double':
        return v.getFloat64(offset, le);
      case 'int64_t':
      case 'long':
        return Number(v.getBigInt64(offset, le));
      case 'uint64_t':
      case 'ulong':
        return Number(v.getBigUint64(offset, le));
      default:
        return 0;
    }
  }
}

/** A struct in the file, read by field name. Missing fields read as undefined, so callers can try the names different Blender versions use. */
export class BStruct {
  constructor(
    readonly file: BlendFile,
    readonly type: DnaStruct,
    readonly offset: number,
    readonly block: BlendBlock,
  ) {}

  get typeName(): string {
    return this.type.name;
  }

  /** The address this struct had when saved. */
  get address(): bigint {
    return this.block.address + BigInt(this.offset - this.block.offset);
  }

  has(name: string): boolean {
    return this.type.fields.has(name);
  }

  field(...names: string[]): DnaField | undefined {
    for (const name of names) {
      const f = this.type.fields.get(name);
      if (f) return f;
    }
    return undefined;
  }

  /** A number field; the first of the names the struct has. */
  num(...names: string[]): number | undefined {
    const f = this.field(...names);
    if (!f || f.pointer || !BASIC_TYPES.has(f.type)) return undefined;
    return this.file.value(f.type, this.offset + f.offset);
  }

  /** A number array field, such as co[3] or mat[4][4], flattened. */
  nums(...names: string[]): number[] | undefined {
    const f = this.field(...names);
    if (!f || f.pointer || !BASIC_TYPES.has(f.type)) return undefined;
    const size = this.file.typeSize(f.type);
    const out: number[] = [];
    for (let i = 0; i < f.length; i++) out.push(this.file.value(f.type, this.offset + f.offset + i * size));
    return out;
  }

  /** A char array field as text, up to its first zero byte. */
  str(...names: string[]): string | undefined {
    const f = this.field(...names);
    if (!f || f.pointer) return undefined;
    const start = this.offset + f.offset;
    let end = start;
    while (end < start + f.size && this.file.bytes[end] !== 0) end++;
    return new TextDecoder().decode(this.file.bytes.subarray(start, end));
  }

  /** A pointer field's address; 0n for null or a missing field. */
  ptr(...names: string[]): bigint {
    const f = this.field(...names);
    if (!f || !f.pointer) return 0n;
    return this.file.pointer(this.offset + f.offset);
  }

  /** The struct a pointer field points to, read with the pointed block's own type unless one is given. */
  deref(name: string | string[], typeName?: string): BStruct | null {
    const address = this.ptr(...(Array.isArray(name) ? name : [name]));
    return address === 0n ? null : this.file.at(address, typeName, this.block);
  }

  /** An embedded struct field, such as id in Object. */
  sub(...names: string[]): BStruct | null {
    const f = this.field(...names);
    if (!f || f.pointer) return null;
    const type = this.file.struct(f.type);
    return type ? new BStruct(this.file, type, this.offset + f.offset, this.block) : null;
  }

  /** The structs of a ListBase field, following first and next. */
  list(name: string | string[], typeName?: string): BStruct[] {
    const base = this.sub(...(Array.isArray(name) ? name : [name]));
    if (!base) return [];
    const out: BStruct[] = [];
    const seen = new Set<bigint>();
    let address = base.ptr('first');
    while (address !== 0n && !seen.has(address) && out.length < 1e6) {
      seen.add(address);
      const item = this.file.at(address, typeName, this.block);
      if (!item) break;
      out.push(item);
      address = item.ptr('next');
    }
    return out;
  }

  /** The ID name without its two-letter type code, for structs that start with an ID. */
  get idName(): string {
    const id = this.sub('id');
    return (id?.str('name') ?? '').slice(2);
  }
}

/** Reads an array of pointers, such as Material **mat. */
export function pointerArray(file: BlendFile, address: bigint, count: number, from?: BlendBlock): bigint[] {
  const found = file.blockAt(address, from);
  if (!found) return [];
  const out: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const at = found.offset + i * file.pointerSize;
    if (at + file.pointerSize > found.block.offset + found.block.length) break;
    out.push(file.pointer(at));
  }
  return out;
}
