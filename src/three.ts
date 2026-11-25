// Builds a three.js scene from a .blend file: the objects of the file's current scene with their
// hierarchy and transforms, collection instances, meshes, materials, lights and cameras.

import * as THREE from 'three';
import { pointerArray, type BlendFile, type BStruct } from './blend-file.js';
import { buildGeometry } from './geometry.js';
import { readMaterial, type BlendMaterialData, type TextureRef } from './material.js';
import { readMesh, type BlendMeshData } from './mesh.js';
import { defaultTextureLoader, type BlendTextureLoader } from './textures.js';

export interface BlendThreeOptions {
  /**
   * Multiplies the intensity of the lights. Lights are converted so that a three.js scene with
   * physically based lighting looks as in Blender: see Documentation/Support.md.
   */
  lightIntensity?: number;
  /** Adds the world colour as an AmbientLight. Default true. */
  worldLight?: boolean;
  /** Adds the scene's cameras. Default true. */
  cameras?: boolean;
  /** Loads textures. Default true. */
  textures?: boolean;
  /** Decodes image files. The default handles PNG, JPEG, GIF, BMP, WebP and AVIF in browsers, and TGA. */
  textureLoader?: BlendTextureLoader;
  /** Objects hidden in renders are left out. Default false: they are added, but not visible. */
  skipHidden?: boolean;
}

/** userData on objects made from Blender objects. */
export interface BlendUserData {
  blender: { kind: 'scene' | 'object' | 'instance'; name: string; type?: string; data?: string; material?: string };
  [key: string]: unknown;
}

export interface BlendBuildStats {
  objects: number;
  meshes: number;
  triangles: number;
  materials: number;
  textures: number;
  lights: number;
  cameras: number;
}

/** Where the builder gets external image files from. */
export type BlendImageSource = (path: string) => Promise<Uint8Array | null>;

const OBJECT_TYPES: Record<number, string> = {
  0: 'empty', 1: 'mesh', 2: 'curve', 3: 'surface', 4: 'text', 5: 'metaball', 10: 'light', 11: 'camera', 12: 'speaker', 13: 'light probe',
  22: 'lattice', 25: 'armature', 26: 'grease pencil', 27: 'curves', 28: 'point cloud', 29: 'volume', 30: 'grease pencil',
};
const OB_DUPLICOLLECTION = 1 << 8;

/** Blender Euler orders (rotmode 1 to 6) as three.js orders: Blender's XYZ applies X first, which is three.js's ZYX. */
const EULER: Record<number, THREE.EulerOrder> = { 1: 'ZYX', 2: 'YZX', 3: 'ZXY', 4: 'XZY', 5: 'YXZ', 6: 'XYZ' };

const linear = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);

export class BlendBuilder {
  readonly warnings: string[] = [];
  readonly stats: BlendBuildStats = { objects: 0, meshes: 0, triangles: 0, materials: 0, textures: 0, lights: 0, cameras: 0 };
  readonly missing = new Set<string>();
  /** The scene's active camera, if it was added. */
  activeCamera: THREE.Camera | null = null;
  /** The world colour, linear. */
  background: THREE.Color | null = null;
  private readonly options: Required<BlendThreeOptions>;
  private readonly meshes = new Map<bigint, BlendMeshData | null>();
  private readonly geometries = new Map<bigint, ReturnType<typeof buildGeometry>>();
  private readonly materialData = new Map<bigint, BlendMaterialData>();
  private readonly materials = new Map<string, Promise<THREE.Material>>();
  private readonly images = new Map<bigint, Promise<THREE.Texture | null>>();
  private readonly materialWarnings = new Set<string>();
  private readonly warned = new Set<string>();
  private aspect = 16 / 9;

  constructor(
    readonly file: BlendFile,
    private readonly imageSource: BlendImageSource,
    options: BlendThreeOptions = {},
  ) {
    this.options = {
      lightIntensity: options.lightIntensity ?? 1,
      worldLight: options.worldLight ?? true,
      cameras: options.cameras ?? true,
      textures: options.textures ?? true,
      textureLoader: options.textureLoader ?? defaultTextureLoader,
      skipHidden: options.skipHidden ?? false,
    };
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warnings.push(message);
  }

  /** The file's current scene, or else its first. */
  scene(): BStruct | null {
    const glob = this.file.blocksWithCode('GLOB')[0];
    const current = glob ? this.file.structOf(glob)?.deref('curscene') : null;
    if (current) return current;
    const first = this.file.blocksWithCode('SC')[0];
    return first ? this.file.structOf(first) : null;
  }

  /** The objects of a collection and its child collections. */
  private collectionObjects(collection: BStruct, seen = new Set<bigint>()): BStruct[] {
    if (seen.has(collection.address)) return [];
    seen.add(collection.address);
    const out: BStruct[] = [];
    for (const item of collection.list('gobject', 'CollectionObject')) {
      const ob = item.deref('ob', 'Object');
      if (ob) out.push(ob);
    }
    for (const child of collection.list('children', 'CollectionChild')) {
      const c = child.deref('collection', 'Collection');
      if (c) out.push(...this.collectionObjects(c, seen));
    }
    return out;
  }

  /** The scene's objects: from its collections (2.80 on) or its bases (before). */
  sceneObjects(scene: BStruct | null): BStruct[] {
    let objects: BStruct[] = [];
    const master = scene?.deref('master_collection', 'Collection');
    if (master) objects = this.collectionObjects(master);
    else if (scene) objects = scene.list('base', 'Base').map((b) => b.deref('object', 'Object')).filter((o): o is BStruct => !!o);
    if (!objects.length) objects = this.file.blocksWithCode('OB').map((b) => this.file.structOf(b)!).filter(Boolean);
    const unique = new Map<bigint, BStruct>();
    for (const o of objects) unique.set(o.address, o);
    return [...unique.values()];
  }

  async build(name: string): Promise<THREE.Group> {
    const scene = this.scene();
    const group = new THREE.Group();
    group.name = scene?.idName || name;
    (group.userData as BlendUserData).blender = { kind: 'scene', name: group.name };
    // Blender is Z up; three.js is Y up.
    group.rotation.x = -Math.PI / 2;
    const unit = scene?.sub('unit')?.num('scale_length') ?? 1;
    if (unit > 0 && unit !== 1) group.scale.setScalar(unit);
    const render = scene?.sub('r');
    if (render) {
      const w = (render.num('xsch') ?? 1920) * (render.num('xasp') ?? 1);
      const h = (render.num('ysch') ?? 1080) * (render.num('yasp') ?? 1);
      if (w > 0 && h > 0) this.aspect = w / h;
    }
    this.readWorld(scene, group);

    const objects = this.sceneObjects(scene);
    const built = new Map<bigint, THREE.Object3D>();
    for (const ob of objects) {
      const object = await this.buildObject(ob, 0);
      if (object) built.set(ob.address, object);
    }
    // Hierarchy: objects whose parent is in the scene go under it.
    for (const ob of objects) {
      const object = built.get(ob.address);
      if (!object) continue;
      const parent = built.get(ob.ptr('parent'));
      (parent ?? group).add(object);
    }
    const camera = scene?.ptr('camera') ?? 0n;
    if (camera && built.has(camera)) {
      const object = built.get(camera)!;
      this.activeCamera = (object.children.find((c) => (c as THREE.Camera).isCamera) as THREE.Camera | undefined) ?? null;
    }
    for (const w of this.materialWarnings) this.warnings.push(w);
    return group;
  }

  private readWorld(scene: BStruct | null, group: THREE.Group): void {
    const world = scene?.deref('world', 'World');
    if (!world) return;
    let color: THREE.Color | null = null;
    let strength = 1;
    const tree = world.num('use_nodes') || this.file.version >= 500 ? world.deref('nodetree', 'bNodeTree') : null;
    const background = tree?.list('nodes', 'bNode').find((n) => n.str('idname') === 'ShaderNodeBackground');
    if (background) {
      for (const s of background.list('inputs', 'bNodeSocket')) {
        const v = this.file.at(s.ptr('default_value'), undefined, s.block)?.nums('value');
        if (!v) continue;
        if (s.str('identifier') === 'Color' && v.length >= 3) color = linear(v[0]!, v[1]!, v[2]!);
        if (s.str('identifier') === 'Strength') strength = v[0] ?? 1;
      }
    }
    if (!color) color = linear(world.num('horr') ?? 0.05, world.num('horg') ?? 0.05, world.num('horb') ?? 0.05);
    this.background = color.clone().multiplyScalar(strength);
    if (this.options.worldLight && this.background.r + this.background.g + this.background.b > 0) {
      // A uniform environment of radiance L lights a matte surface like an ambient light of L × π.
      const ambient = new THREE.AmbientLight(this.background, Math.PI * this.options.lightIntensity);
      ambient.name = 'World';
      group.add(ambient);
    }
  }

  /** The object's transform relative to its parent: parent inverse × translation × rotation × scale. */
  private localMatrix(ob: BStruct): THREE.Matrix4 {
    const v = (names: string[], fallback: number[]) => ob.nums(...names) ?? fallback;
    const loc = v(['loc'], [0, 0, 0]);
    const dloc = v(['dloc'], [0, 0, 0]);
    const scale = v(['scale', 'size'], [1, 1, 1]);
    const dscale = v(['dscale', 'dsize'], [1, 1, 1]);
    const mode = ob.num('rotmode') ?? 1;
    const q = new THREE.Quaternion();
    if (mode === 0) {
      const [w, x, y, z] = v(['quat'], [1, 0, 0, 0]);
      q.set(x!, y!, z!, w!).normalize();
      const [dw, dx, dy, dz] = v(['dquat'], [1, 0, 0, 0]);
      q.premultiply(new THREE.Quaternion(dx!, dy!, dz!, dw!).normalize());
    } else if (mode === -1) {
      const axis = new THREE.Vector3().fromArray(v(['rotAxis'], [0, 1, 0]));
      if (axis.lengthSq() === 0) axis.set(0, 1, 0);
      q.setFromAxisAngle(axis.normalize(), ob.num('rotAngle') ?? 0);
    } else {
      const order = EULER[mode] ?? 'ZYX';
      const r = v(['rot'], [0, 0, 0]);
      const d = v(['drot'], [0, 0, 0]);
      q.setFromEuler(new THREE.Euler(r[0], r[1], r[2], order));
      if (d.some((x) => x !== 0)) q.premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(d[0], d[1], d[2], order)));
    }
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(loc[0]! + dloc[0]!, loc[1]! + dloc[1]!, loc[2]! + dloc[2]!),
      q,
      new THREE.Vector3(scale[0]! * dscale[0]!, scale[1]! * dscale[1]!, scale[2]! * dscale[2]!),
    );
    if (ob.ptr('parent') !== 0n) {
      const pi = ob.nums('parentinv');
      // DNA matrices are float[4][4] rows that hold columns, as three.js's column-major arrays do.
      if (pi && pi.length === 16) local.premultiply(new THREE.Matrix4().fromArray(pi));
    }
    return local;
  }

  private hiddenInRenders(ob: BStruct): boolean {
    const OB_HIDE_RENDER = 1 << 2;
    const OB_RESTRICT_RENDER = 1 << 2;
    if (ob.has('visibility_flag')) return ((ob.num('visibility_flag') ?? 0) & OB_HIDE_RENDER) !== 0;
    return ((ob.num('restrictflag') ?? 0) & OB_RESTRICT_RENDER) !== 0;
  }

  private async buildObject(ob: BStruct, depth: number): Promise<THREE.Object3D | null> {
    const name = ob.idName;
    const typeCode = ob.num('type') ?? 0;
    const type = OBJECT_TYPES[typeCode] ?? `type ${typeCode}`;
    const hidden = this.hiddenInRenders(ob);
    if (hidden && this.options.skipHidden) return null;
    const object = new THREE.Group();
    object.name = name;
    object.matrixAutoUpdate = true;
    this.localMatrix(ob).decompose(object.position, object.quaternion, object.scale);
    object.visible = !hidden;
    (object.userData as BlendUserData).blender = { kind: 'object', name, type };
    this.stats.objects++;

    const dataAddress = ob.ptr('data');
    if (typeCode === 1 && dataAddress) {
      const mesh = await this.buildMesh(ob, dataAddress);
      if (mesh) object.add(mesh);
    } else if (typeCode === 10 && dataAddress) {
      const light = this.file.at(dataAddress);
      if (light) object.add(this.buildLight(light));
    } else if (typeCode === 11 && dataAddress) {
      const camera = this.file.at(dataAddress, 'Camera');
      if (camera && this.options.cameras) object.add(this.buildCamera(camera));
    } else if (typeCode !== 0) {
      this.warnOnce(`type:${type}`, `${type[0]!.toUpperCase()}${type.slice(1)} objects are not read: ${name}`);
    }
    const modifiers = ob.list('modifiers').map((m) => m.str('name') ?? '').filter(Boolean);
    if (modifiers.length && typeCode === 1) this.warnings.push(`Object ${name}: modifiers are not applied (${modifiers.join(', ')})`);

    // Collection instances.
    const instance = ob.deref(['instance_collection', 'dup_group'], 'Collection');
    if (instance && ((ob.num('transflag') ?? 0) & OB_DUPLICOLLECTION) && depth < 8) {
      const holder = new THREE.Group();
      holder.name = instance.idName;
      (holder.userData as BlendUserData).blender = { kind: 'instance', name: instance.idName };
      const offset = instance.nums('instance_offset', 'dupli_ofs') ?? [0, 0, 0];
      holder.position.set(-offset[0]!, -offset[1]!, -offset[2]!);
      const members = this.collectionObjects(instance);
      const made = new Map<bigint, THREE.Object3D>();
      for (const member of members) {
        const child = await this.buildObject(member, depth + 1);
        if (child) made.set(member.address, child);
      }
      for (const member of members) {
        const child = made.get(member.address);
        if (child) (made.get(member.ptr('parent')) ?? holder).add(child);
      }
      object.add(holder);
    }
    return object;
  }

  private meshData(address: bigint): BlendMeshData | null {
    if (this.meshes.has(address)) return this.meshes.get(address)!;
    const me = this.file.at(address, 'Mesh');
    let data: BlendMeshData | null = null;
    try {
      data = me ? readMesh(this.file, me, this.warnings) : null;
    } catch (error) {
      this.warnings.push((error as Error).message);
    }
    this.meshes.set(address, data);
    return data;
  }

  private async buildMesh(ob: BStruct, address: bigint): Promise<THREE.Object3D | null> {
    const data = this.meshData(address);
    if (!data) return null;
    if (!this.geometries.has(address)) this.geometries.set(address, buildGeometry(data));
    const built = this.geometries.get(address);
    if (!built) return null;
    // Material slots: linked to the object or to the mesh, slot by slot.
    const totcol = ob.num('totcol') ?? 0;
    const objectMats = totcol ? pointerArray(this.file, ob.ptr('mat'), totcol, ob.block) : [];
    const matbits = ob.ptr('matbits');
    const bits = matbits ? this.file.blockAt(matbits, ob.block) : null;
    const slotMaterial = (slot: number): bigint => {
      const useObject = bits ? this.file.bytes[bits.offset + slot] === 1 : false;
      return (useObject ? objectMats[slot] : data.materials[slot]) ?? data.materials[slot] ?? 0n;
    };
    const uvNames = data.uvs.map((u) => u.name);
    const hasColors = !!data.colors;
    const materials = await Promise.all(built.slots.map((slot) => this.material(slotMaterial(slot), uvNames, hasColors)));
    const mesh = new THREE.Mesh(built.geometry, materials.length === 1 ? materials[0]! : materials);
    mesh.name = data.name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    (mesh.userData as BlendUserData).blender = { kind: 'object', name: ob.idName, type: 'mesh', data: data.name };
    this.stats.meshes++;
    this.stats.triangles += built.triangles;
    return mesh;
  }

  private material(address: bigint, uvNames: string[], hasColors: boolean): Promise<THREE.Material> {
    const key = `${address}|${uvNames.join('/')}|${hasColors}`;
    let material = this.materials.get(key);
    if (!material) {
      material = this.makeMaterial(address, uvNames, hasColors);
      this.materials.set(key, material);
    }
    return material;
  }

  private async makeMaterial(address: bigint, uvNames: string[], hasColors: boolean): Promise<THREE.Material> {
    this.stats.materials++;
    if (address === 0n) return new THREE.MeshStandardMaterial({ name: 'Default', color: linear(0.8, 0.8, 0.8), roughness: 0.5, side: THREE.DoubleSide });
    let m = this.materialData.get(address);
    if (!m) {
      const ma = this.file.at(address, 'Material');
      if (!ma) return new THREE.MeshStandardMaterial({ name: 'Missing', side: THREE.DoubleSide });
      m = readMaterial(this.file, ma, this.materialWarnings);
      this.materialData.set(address, m);
    }
    const physical = m.transmission > 0 || m.coat > 0 || m.sheen > 0;
    const material = m.unlit
      ? new THREE.MeshBasicMaterial()
      : physical
        ? new THREE.MeshPhysicalMaterial()
        : new THREE.MeshStandardMaterial();
    material.name = m.name;
    material.userData.blender = { material: m.name, source: m.source };
    material.color = linear(m.baseColor[0], m.baseColor[1], m.baseColor[2]);
    material.side = m.backfaceCulling ? THREE.FrontSide : THREE.DoubleSide;
    material.vertexColors = m.vertexColor && hasColors;
    if (material instanceof THREE.MeshStandardMaterial) {
      material.metalness = m.metallic;
      material.roughness = m.roughness;
      material.emissive = linear(m.emission[0], m.emission[1], m.emission[2]);
    }
    if (material instanceof THREE.MeshPhysicalMaterial) {
      material.transmission = m.transmission;
      material.ior = Math.min(2.333, Math.max(1, m.ior));
      material.clearcoat = m.coat;
      material.clearcoatRoughness = m.coatRoughness;
      material.sheen = m.sheen;
      if (m.transmission > 0) material.thickness = 0;
    }
    material.opacity = m.alpha;
    switch (m.blend) {
      case 'blend':
        material.transparent = m.alpha < 1 || !!m.maps.alpha;
        break;
      case 'clip':
        material.alphaTest = m.alphaThreshold;
        break;
      case 'hashed':
        material.alphaHash = true;
        break;
    }

    if (this.options.textures) {
      const channel = (ref: TextureRef) => Math.max(0, ref.uvMap ? uvNames.indexOf(ref.uvMap) : 0);
      const tex = async (ref: TextureRef | undefined, colour: boolean) => {
        if (!ref) return null;
        const base = await this.image(ref.image);
        if (!base) return null;
        const t = base.clone();
        t.colorSpace = colour && base.colorSpace !== THREE.NoColorSpace ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.channel = Math.min(3, channel(ref));
        t.needsUpdate = true;
        this.stats.textures++;
        return t;
      };
      const map = await tex(m.maps.baseColor, true);
      // The base colour multiplies the map, as a glTF factor does.
      if (map) material.map = map;
      if (m.maps.alpha) {
        if (m.maps.baseColor && m.maps.alpha.image === m.maps.baseColor.image && m.maps.alpha.channel === 'a') {
          // The base colour image's own alpha: three.js takes it from the map.
          if (m.blend === 'opaque') material.transparent = true;
        } else {
          this.warnOnce(`alpha:${m.name}`, `Material ${m.name}: alpha from a separate texture is not read`);
        }
      }
      if (material instanceof THREE.MeshStandardMaterial) {
        const roughness = await tex(m.maps.roughness, false);
        if (roughness) {
          material.roughnessMap = roughness;
          if (m.maps.roughness?.channel && m.maps.roughness.channel !== 'g') this.warnOnce(`rch:${m.name}`, `Material ${m.name}: roughness comes from the ${m.maps.roughness.channel} channel, but three.js reads green`);
        }
        const metalness = await tex(m.maps.metallic, false);
        if (metalness) {
          material.metalnessMap = metalness;
          if (m.maps.metallic?.channel && m.maps.metallic.channel !== 'b') this.warnOnce(`mch:${m.name}`, `Material ${m.name}: metallic comes from the ${m.maps.metallic.channel} channel, but three.js reads blue`);
        }
        const normal = await tex(m.maps.normal, false);
        if (normal) {
          material.normalMap = normal;
          material.normalScale.set(m.normalStrength, m.normalStrength);
        }
        const emissive = await tex(m.maps.emission, true);
        if (emissive) material.emissiveMap = emissive;
      }
    }
    material.needsUpdate = true;
    return material;
  }

  /** An image: packed in the file, or found among the files given. */
  private image(address: bigint): Promise<THREE.Texture | null> {
    let texture = this.images.get(address);
    if (!texture) {
      texture = this.loadImage(address);
      this.images.set(address, texture);
    }
    return texture;
  }

  private async loadImage(address: bigint): Promise<THREE.Texture | null> {
    const image = this.file.at(address, 'Image');
    if (!image) return null;
    const name = image.idName;
    const path = image.str('filepath', 'name') ?? name;
    let data: Uint8Array | null = null;
    // Packed data: packedfiles (2.80 on) or packedfile.
    const packed = image.list('packedfiles', 'ImagePackedFile')[0]?.deref('packedfile', 'PackedFile') ?? image.deref('packedfile', 'PackedFile');
    if (packed) {
      const found = this.file.blockAt(packed.ptr('data'), packed.block);
      const size = packed.num('size') ?? 0;
      if (found) data = this.file.bytes.subarray(found.offset, found.offset + Math.min(size || found.block.length, found.block.length));
    }
    if (!data) {
      const fileName = path.replace(/^\/\//, '').replace(/\\/g, '/');
      data = await this.imageSource(fileName);
      if (!data) {
        this.missing.add(fileName.split('/').pop() ?? fileName);
        this.warnOnce(`img:${fileName}`, `Image ${name} (${path}) was not found`);
        return null;
      }
    }
    try {
      const texture = await this.options.textureLoader(path || name, data);
      if (!texture) {
        this.warnOnce('img:decode', 'Images were not decoded: this environment has no createImageBitmap; pass a textureLoader');
        return null;
      }
      texture.name = name;
      const space = image.sub('colorspace_settings')?.str('name') ?? '';
      texture.colorSpace = /non-?color|raw|linear|data/i.test(space) ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      return texture;
    } catch (error) {
      this.warnOnce(`img:${name}`, `Image ${name} could not be read: ${(error as Error).message}`);
      return null;
    }
  }

  buildLight(light: BStruct): THREE.Light {
    const type = light.num('type') ?? 0;
    const color = linear(light.num('r') ?? 1, light.num('g') ?? 1, light.num('b') ?? 1);
    const k = this.options.lightIntensity;
    const v280 = this.file.version >= 280;
    const energy = light.num('energy') ?? 1;
    let object: THREE.Light;
    // Blender 2.80 and later: watts. A point light of P watts has an intensity of P / 4π; a sun's
    // strength is its irradiance. Before 2.80, Blender Internal lamps had a unitless energy, with
    // a falloff over the lamp's distance.
    const falloff = light.num('falloff_type') ?? 2;
    const dist = light.num('dist') ?? 25;
    const legacy = (base: number) => {
      const scaled = base * Math.PI;
      if (falloff === 0) return { intensity: scaled, decay: 0 };
      if (falloff === 1) return { intensity: scaled * dist, decay: 1 };
      return { intensity: scaled * dist * dist, decay: 2 };
    };
    if (type === 1 || (!v280 && type === 3)) {
      // Sun (and the old hemi lamp).
      const sun = new THREE.DirectionalLight(color, (v280 ? energy : energy * Math.PI) * k);
      sun.target.position.set(0, 0, -1);
      sun.add(sun.target);
      object = sun;
    } else if (type === 2) {
      const { intensity, decay } = v280 ? { intensity: energy / (4 * Math.PI), decay: 2 } : legacy(energy);
      const size = light.num('spotsize') ?? Math.PI / 4;
      const spot = new THREE.SpotLight(color, intensity * k, 0, Math.min(Math.PI / 2, size / 2), Math.min(1, Math.max(0, light.num('spotblend') ?? 0.15)), decay);
      spot.target.position.set(0, 0, -1);
      spot.add(spot.target);
      object = spot;
    } else {
      if (type === 4) this.warnOnce('area', 'Area lights are read as point lights');
      const { intensity, decay } = v280 ? { intensity: energy / (4 * Math.PI), decay: 2 } : legacy(energy);
      object = new THREE.PointLight(color, intensity * k, 0, decay);
    }
    // three.js puts new lights at (0, 1, 0); this one sits at its object.
    object.position.set(0, 0, 0);
    object.name = light.idName;
    object.castShadow = true;
    this.stats.lights++;
    return object;
  }

  buildCamera(cam: BStruct): THREE.Camera {
    const type = cam.num('type') ?? 0;
    const aspect = this.aspect;
    const near = cam.num('clip_start', 'clipsta') ?? 0.1;
    const far = cam.num('clip_end', 'clipend') ?? 100;
    let camera: THREE.Camera;
    if (type === 1) {
      const scale = cam.num('ortho_scale') ?? 6;
      const w = aspect >= 1 ? scale : scale * aspect;
      const h = w / aspect;
      camera = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, near, far);
    } else {
      if (type === 2) this.warnOnce('pano', 'Panoramic cameras are read as perspective cameras');
      const lens = cam.num('lens') ?? 50;
      const sensorX = cam.num('sensor_x') ?? 36;
      const sensorY = cam.num('sensor_y') ?? 24;
      const fit = cam.num('sensor_fit') ?? 0;
      let vfov: number;
      if (fit === 2) vfov = 2 * Math.atan(sensorY / 2 / lens);
      else if (fit === 1 || aspect >= 1) vfov = 2 * Math.atan(Math.tan(Math.atan(sensorX / 2 / lens)) / aspect);
      else vfov = 2 * Math.atan(sensorX / 2 / lens);
      camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(vfov), aspect, near, far);
    }
    camera.name = cam.idName;
    this.stats.cameras++;
    return camera;
  }
}
