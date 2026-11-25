// Default texture decoding. Blender's texture coordinates start at the bottom left, as three.js's
// do with flipped images, so textures come out flipped: image bitmaps are decoded upside down
// (WebGL can't flip them on upload) and TGA data is flipped on upload.

import * as THREE from 'three';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';

/** Turns an image file into a three.js texture for Blender's texture coordinates; returns null if it can't. */
export type BlendTextureLoader = (name: string, data: Uint8Array) => Promise<THREE.Texture | null>;

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  avif: 'image/avif',
};

export class TextureFormatError extends Error {
  override name = 'TextureFormatError';
}

/** The image type from the file's first bytes, for packed images whose names may not say. */
function sniff(data: Uint8Array): string | null {
  if (data[0] === 0x89 && data[1] === 0x50) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'jpg';
  if (data[0] === 0x47 && data[1] === 0x49) return 'gif';
  if (data[0] === 0x42 && data[1] === 0x4d) return 'bmp';
  if (data[0] === 0x52 && data[1] === 0x49 && data[8] === 0x57) return 'webp';
  return null;
}

/** Decodes PNG, JPEG, GIF, BMP, WebP and AVIF in browsers and workers, and TGA anywhere. */
export const defaultTextureLoader: BlendTextureLoader = async (name, data) => {
  const ext = sniff(data) ?? name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'tga') {
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const parsed = new TGALoader().parse(buffer) as { data: Uint8Array; width: number; height: number };
    const texture = new THREE.DataTexture(parsed.data, parsed.width, parsed.height, THREE.RGBAFormat);
    texture.flipY = true;
    texture.needsUpdate = true;
    return texture;
  }
  const type = IMAGE_TYPES[ext];
  if (!type) throw new TextureFormatError(`.${ext} images are not supported`);
  if (typeof createImageBitmap !== 'function') return null;
  const bitmap = await createImageBitmap(new Blob([data as BlobPart], { type }), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const texture = new THREE.Texture(bitmap as unknown as HTMLImageElement);
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
};
