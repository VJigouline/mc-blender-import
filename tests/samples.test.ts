// Loads real .blend files saved by Blender 2.78 to 5.2 (see samples/README.md).

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BlendFile, decompressBlend, loadBlend, readMesh, type BlendTextureLoader } from '../src/index.js';

const dir = fileURLToPath(new URL('./samples/', import.meta.url));
const read = (name: string) => ({ name, data: new Uint8Array(readFileSync(dir + name)) });
const textures = readdirSync(dir).filter((n) => n.endsWith('.png')).map(read);

/** Records the images asked for and gives each a 1 x 1 texture, as Node can't decode PNG. */
function recordingLoader(): { loader: BlendTextureLoader; names: string[] } {
  const names: string[] = [];
  const loader: BlendTextureLoader = async (name) => {
    names.push(name);
    return new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  };
  return { loader, names };
}

const load = (name: string, withTextures = false) => {
  const { loader, names } = recordingLoader();
  return loadBlend([read(`${name}.blend`), ...(withTextures ? textures : [])], { textureLoader: loader }).then((r) => ({ ...r, images: names }));
};

function meshes(group: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

const world = (o: THREE.Object3D) => {
  o.updateWorldMatrix(true, false);
  return o.getWorldPosition(new THREE.Vector3()).toArray().map((x) => Math.round(x * 100) / 100 + 0);
};

describe('Blender sample scenes', () => {
  it('reads the headers of every version', async () => {
    const versions: Record<string, number> = {};
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.blend'))) {
      const file = new BlendFile(await decompressBlend(read(name).data));
      versions[name.replace('.blend', '')] = file.version;
      expect(file.pointerSize, name).toBe(8);
      expect(file.struct('Object'), name).toBeDefined();
    }
    expect(versions['01_cube']).toBe(278);
    expect(versions['01_principled_material']).toBe(279);
    expect(versions['11_loose_geometry']).toBe(291);
    expect(versions['39_parenting_full_hierarchy']).toBe(502);
  });

  it('loads a cube, Z up turned to Y up, with its camera', async () => {
    const r = await load('01_cube');
    expect(r.version).toBe(278);
    expect(r.stats).toMatchObject({ objects: 2, meshes: 1, triangles: 12, cameras: 1 });
    const size = new THREE.Box3().setFromObject(r.group).getSize(new THREE.Vector3());
    expect(size.toArray().map((x) => Math.round(x * 100) / 100)).toEqual([2, 2, 2]);
    // The camera at Blender (7.48, -6.51, 5.34) is at three.js (7.48, 5.34, 6.51).
    expect(world(r.group.getObjectByName('Camera')!)).toEqual([7.48, 5.34, 6.51]);
    expect(r.camera).toBeInstanceOf(THREE.PerspectiveCamera);
    // The old glTF exporter's node group: glTF's default factors.
    const material = meshes(r.group)[0]!.material as THREE.MeshStandardMaterial;
    expect(material.color.getHexString()).toBe('ffffff');
    expect(material.metalness).toBe(1);
    expect(material.roughness).toBe(1);
    expect(material.transparent).toBe(false);
  });

  it('shares the geometry of objects that share a mesh', async () => {
    const r = await load('02_shared_mesh');
    const [a, b] = meshes(r.group);
    expect(a!.geometry).toBe(b!.geometry);
    expect(world(a!.parent!)).toEqual([4, 0, 0]);
  });

  it('keeps parented objects under their parent', async () => {
    const r = await load('02_node_hierarchy');
    const sphere = r.group.getObjectByName('Flat_Sphere')!;
    expect(sphere.parent?.name).toBe('Cube');
    expect(world(sphere)).toEqual([4, 4, 0]);
  });

  it('reads Blender Internal lamps with their falloff', async () => {
    const r = await load('04_lights');
    // Objects and their lights share a name; find the light itself.
    const light = <T extends THREE.Light>(name: string) => r.group.getObjectByName(name)!.children.find((c) => (c as THREE.Light).isLight) as T;
    expect(r.stats.lights).toBe(7);
    expect(light('Directional')).toBeInstanceOf(THREE.DirectionalLight);
    const constant = light<THREE.PointLight>('Point_Constant');
    const linear = light<THREE.PointLight>('Point_Linear');
    const quadratic = light<THREE.PointLight>('Point_Quadratic');
    expect([constant.decay, linear.decay, quadratic.decay]).toEqual([0, 1, 2]);
    expect(constant.color.getHexString()).toBe('ff0000');
    // Energy 1 at a distance of 10.
    expect(linear.intensity).toBeCloseTo(Math.PI * 10);
    expect(quadratic.intensity).toBeCloseTo(Math.PI * 100);
    const spot = light<THREE.SpotLight>('Spot_Quadratic');
    expect(spot.angle).toBeCloseTo(0.5236 / 2, 3);
    expect(spot.penumbra).toBe(1);
    // Lights sit at their objects and point down their -Z axis.
    expect(world(spot)).toEqual([8, 4, -8]);
    expect(world(spot.target)[1]).toBeLessThan(4);
  });

  it('reads a Principled BSDF with its textures', async () => {
    const r = await load('01_principled_material', true);
    expect(r.missing).toEqual([]);
    expect(r.images.sort()).toEqual(['//01_principled_baseColor.png', '//01_principled_emissive.png', '//01_principled_normal.png', '//01_principled_occlusionRoughnessMetallic.png']);
    const m = meshes(r.group)[0]!.material as THREE.MeshStandardMaterial;
    expect(m.name).toBe('TestMaterial');
    expect(m.map?.name).toBe('01_principled_baseColor.png');
    expect(m.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(m.roughnessMap?.name).toBe('01_principled_occlusionRoughnessMetallic.png');
    expect(m.metalnessMap).toBeTruthy();
    expect(m.normalMap?.name).toBe('01_principled_normal.png');
    expect(m.normalMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(m.emissiveMap?.name).toBe('01_principled_emissive.png');
    // Roughness and metallic come from the green and blue channels, as three.js reads them.
    expect(r.warnings.filter((w) => w.includes('channel'))).toEqual([]);
  });

  it('reports images that are neither packed nor given', async () => {
    const r = await load('01_textured_sphere');
    expect(r.missing.sort()).toEqual(['01_Textured_Sphere_BaseColor.png', '01_Textured_Sphere_Normal.png', '01_Textured_Sphere_OcclusionRoughnessMetallic.png']);
    const withImages = await load('01_textured_sphere', true);
    const m = meshes(withImages.group)[0]!.material as THREE.MeshStandardMaterial;
    expect([!!m.map, !!m.normalMap, !!m.roughnessMap, !!m.metalnessMap]).toEqual([true, true, true, true]);
  });

  it('reads vertex colours', async () => {
    const r = await load('01_color_attribute');
    const mesh = meshes(r.group)[0]!;
    const colors = Array.from(mesh.geometry.getAttribute('color').array as Float32Array).map((x) => Math.round(x * 100) / 100);
    expect(colors).toEqual([0, 1, 0, 1, 0.01, 0.01, 1, 1, 1, 0, 0, 1]);
    expect((mesh.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
  });

  it('reads alpha blending', async () => {
    const r = await load('01_alpha_blend', true);
    const plane = meshes(r.group).find((m) => m.name === 'Transparent_Plane')!;
    const material = plane.material as THREE.MeshStandardMaterial;
    expect(material.transparent).toBe(true);
    expect(material.map?.name).toBe('01_alpha_blend.png');
  });

  it('leaves out loose vertices and edges', async () => {
    const r = await load('11_loose_geometry');
    expect(r.stats.triangles).toBe(6);
    const file = new BlendFile(read('11_loose_geometry.blend').data);
    const mesh = readMesh(file, file.structOf(file.blocksWithCode('ME')[0]!)!, []);
    expect(mesh!.positions.length / 3).toBe(11);
    expect(mesh!.looseEdges?.length).toBeGreaterThan(0);
  });

  it('reads Blender 5.2 meshes and lights in watts', async () => {
    const r = await load('37_lamp_EEVEE');
    expect(r.version).toBe(502);
    expect(r.stats).toMatchObject({ meshes: 1, triangles: 12, lights: 1, cameras: 1 });
    const light = r.group.getObjectByName('Light')!.children[0] as THREE.PointLight;
    expect(light).toBeInstanceOf(THREE.PointLight);
    expect(light.intensity).toBeCloseTo(1000 / (4 * Math.PI));
    expect(light.color.getHexString()).toBe('0000ff');
    const material = meshes(r.group)[0]!.material as THREE.MeshStandardMaterial;
    expect(material.roughness).toBe(0.5);
    expect(material.color.getHexString(THREE.LinearSRGBColorSpace)).toBe('cccccc');
  });

  it('builds parenting and nested collection instances from Blender 5.2', async () => {
    const r = await load('39_parenting_full_hierarchy');
    expect(r.stats).toMatchObject({ objects: 28, meshes: 19, triangles: 7208 });
    for (const mesh of meshes(r.group)) {
      const p = mesh.geometry.getAttribute('position').array as Float32Array;
      expect(Array.from(p).every(Number.isFinite), mesh.name).toBe(true);
    }
    const instances: string[] = [];
    r.group.traverse((o) => {
      if (o.userData.blender?.kind === 'instance') instances.push(o.name);
    });
    expect(instances.filter((n) => n === 'MyCollection')).toHaveLength(4);
    expect(world(r.group.getObjectByName('Torus')!)).toEqual([0, 0, 9]);
  });

  it('reads transmission into a physical material', async () => {
    const r = await load('01_dispersion');
    const physical = meshes(r.group).filter((m) => (m.material as THREE.Material).type === 'MeshPhysicalMaterial');
    expect(physical).toHaveLength(4);
    expect((physical[0]!.material as THREE.MeshPhysicalMaterial).transmission).toBe(1);
  });

  it('reads gzip-compressed files, as Blender saved them before 3.0', async () => {
    const raw = read('01_cube.blend').data;
    const gz = new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    const r = await loadBlend(gz);
    expect(r.stats.triangles).toBe(12);
  });
});
