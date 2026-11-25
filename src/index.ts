import type * as THREE from 'three';
import { BlendFile, decompressBlend, isBlend } from './blend-file.js';
import { BlendResources, type BlendData, type BlendInput, type BlendResolver } from './resources.js';
import { BlendBuilder, type BlendBuildStats, type BlendThreeOptions } from './three.js';

export { BlendFile, BStruct, BlendFileError, decompressBlend, isBlend, isZstd, isGzip, pointerArray } from './blend-file.js';
export type { BlendBlock, DnaField, DnaStruct } from './blend-file.js';
export { readMesh, BlendMeshError } from './mesh.js';
export type { BlendMeshData, Domain } from './mesh.js';
export { readMaterial } from './material.js';
export type { BlendMaterialData, TextureRef, Rgba } from './material.js';
export { buildGeometry } from './geometry.js';
export type { GeometryResult } from './geometry.js';
export { BlendBuilder } from './three.js';
export type { BlendThreeOptions, BlendUserData, BlendBuildStats, BlendImageSource } from './three.js';
export { defaultTextureLoader, TextureFormatError } from './textures.js';
export type { BlendTextureLoader } from './textures.js';
export { BlendResources } from './resources.js';
export type { BlendInput, BlendData, BlendResolver } from './resources.js';
export { readZip, isZip, ZipError } from './zip.js';
export type { ZipEntry } from './zip.js';

export interface BlendLoadOptions extends BlendThreeOptions {
  /** The .blend file to open, if several are given. By default, the first. */
  main?: string;
  /** Fetches images that are neither packed nor among the files, such as from a server. */
  resolve?: BlendResolver;
}

export interface BlendLoadResult {
  /** The scene for three.js, in metres, Y up. */
  group: THREE.Group;
  /** The Blender version that saved the file, such as 279 or 502. */
  version: number;
  /** The scene's active camera, if it was added. */
  camera: THREE.Camera | null;
  /** The world colour, linear, if the scene has a world. */
  background: THREE.Color | null;
  /** Images the file refers to that are neither packed nor among the files. */
  missing: string[];
  /** Problems that didn't stop the import. */
  warnings: string[];
  stats: BlendBuildStats;
}

export class BlendImportError extends Error {
  override name = 'BlendImportError';
}

const isBytes = (x: unknown): x is ArrayBuffer | Uint8Array => x instanceof ArrayBuffer || x instanceof Uint8Array;

/**
 * Reads a .blend file into a three.js group. Pass the file's bytes, or a set of files: the
 * .blend file with the images it uses (by file name, wherever they are), loose or in a zip.
 * Images packed into the .blend file need no other files.
 */
export async function loadBlend(input: ArrayBuffer | Uint8Array | Iterable<BlendInput> | BlendInput, options: BlendLoadOptions = {}): Promise<BlendLoadResult> {
  const resources = await BlendResources.from(isBytes(input) ? [{ name: 'model.blend', data: input as BlendData }] : input, options.resolve);
  const blends = resources.withExtension('blend');
  const main = options.main ? (resources.resolveName(options.main) ?? options.main) : blends[0];
  if (!main) throw new BlendImportError('There is no .blend file to open');
  const raw = await resources.bytes(main);
  if (!raw) throw new BlendImportError(`${main} was not found`);
  if (!isBlend(raw)) throw new BlendImportError(`${main} is not a .blend file`);
  const file = new BlendFile(await decompressBlend(raw));
  const builder = new BlendBuilder(
    file,
    async (path) => {
      // Relative paths (//textures/a.png) are tried as they are, then by file name.
      const bytes = await resources.bytes(path);
      return bytes ?? resources.bytes(path.split('/').pop() ?? path);
    },
    options,
  );
  const name = main.replace(/\\/g, '/').split('/').pop()!.replace(/\.blend\d*$/i, '');
  const group = await builder.build(name);
  return {
    group,
    version: file.version,
    camera: builder.activeCamera,
    background: builder.background,
    missing: [...builder.missing],
    warnings: [...new Set(builder.warnings)],
    stats: builder.stats,
  };
}

/** Fetches a .blend file from a URL; external images are fetched from beside it. */
export async function loadBlendFromUrl(url: string | URL, options: BlendThreeOptions & { fetch?: typeof fetch } = {}): Promise<BlendLoadResult> {
  const get = options.fetch ?? fetch;
  const base = new URL(url, typeof location !== 'undefined' ? location.href : undefined);
  const response = await get(base);
  if (!response.ok) throw new BlendImportError(`${base.href} could not be fetched`);
  const name = decodeURIComponent(base.pathname.split('/').pop() ?? 'model.blend');
  return loadBlend([{ name, data: new Uint8Array(await response.arrayBuffer()) }], {
    ...options,
    main: name,
    resolve: async (path) => {
      const r = await get(new URL(path, base));
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    },
  });
}
