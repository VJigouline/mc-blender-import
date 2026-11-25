import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BlendFile, BlendFileError, buildGeometry, isBlend, loadBlend, type BlendMeshData } from '../src/index.js';

function mesh(positions: number[], faces: number[][], extra: Partial<BlendMeshData> = {}): BlendMeshData {
  const offsets = [0];
  for (const f of faces) offsets.push(offsets[offsets.length - 1]! + f.length);
  return {
    name: 'test',
    positions: Float32Array.from(positions),
    faceOffsets: Uint32Array.from(offsets),
    cornerVerts: Uint32Array.from(faces.flat()),
    materialIndex: null,
    smooth: null,
    autoSmoothAngle: null,
    uvs: [],
    colors: null,
    materials: [],
    looseEdges: null,
    ...extra,
  };
}

const area = (g: THREE.BufferGeometry) => {
  const p = g.getAttribute('position');
  const i = g.index!;
  let sum = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < i.count; t += 3) {
    a.fromBufferAttribute(p, i.getX(t));
    b.fromBufferAttribute(p, i.getX(t + 1));
    c.fromBufferAttribute(p, i.getX(t + 2));
    sum += new THREE.Triangle(a, b, c).getArea();
  }
  return sum;
};

describe('geometry', () => {
  it('triangulates a concave face without covering its notch', () => {
    // An L shape of area 3 in the XY plane.
    const l = mesh([0, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, 1, 2, 0, 0, 2, 0], [[0, 1, 2, 3, 4, 5]]);
    const built = buildGeometry(l)!;
    expect(built.triangles).toBe(4);
    expect(area(built.geometry)).toBeCloseTo(3);
    // Every triangle faces +Z, as the face does.
    const n = built.geometry.getAttribute('normal');
    expect(n.getZ(0)).toBeCloseTo(1);
  });

  it('gives flat faces their face normal and smooth faces a shared vertex normal', () => {
    // Two faces meeting at a right angle along the edge 1-2.
    const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, -1, 1, 1, -1];
    const faces = [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
    ];
    const flat = buildGeometry(mesh(positions, faces))!.geometry.getAttribute('normal');
    expect([flat.getX(1), flat.getY(1), flat.getZ(1)].map((x) => Math.round(x * 1000) / 1000 + 0)).toEqual([0, 0, 1]);
    const smooth = buildGeometry(mesh(positions, faces, { smooth: Uint8Array.from([1, 1]) }))!.geometry.getAttribute('normal');
    // At the shared edge the normal is halfway between +Z and +X.
    expect(smooth.getX(1)).toBeCloseTo(Math.SQRT1_2);
    expect(smooth.getZ(1)).toBeCloseTo(Math.SQRT1_2);
    // The auto smooth angle splits them again.
    const split = buildGeometry(mesh(positions, faces, { smooth: Uint8Array.from([1, 1]), autoSmoothAngle: Math.PI / 6 }))!.geometry.getAttribute('normal');
    expect(split.getZ(1)).toBeCloseTo(1);
  });

  it('groups triangles by material slot', () => {
    const quad = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
    const built = buildGeometry(mesh(quad, [[0, 1, 2], [0, 2, 3], [0, 1, 3]], { materialIndex: Int32Array.from([2, 0, 2]) }))!;
    expect(built.slots).toEqual([0, 2]);
    expect(built.geometry.groups.map((g) => [g.start, g.count, g.materialIndex])).toEqual([
      [0, 3, 0],
      [3, 6, 1],
    ]);
  });
});

describe('input', () => {
  it('refuses files that are not .blend files', async () => {
    const bytes = new TextEncoder().encode('not a blend file');
    expect(isBlend(bytes)).toBe(false);
    expect(() => new BlendFile(bytes)).toThrow(BlendFileError);
    await expect(loadBlend([{ name: 'model.blend', data: bytes }])).rejects.toThrow(/not a .blend file/);
    await expect(loadBlend([{ name: 'image.png', data: bytes }])).rejects.toThrow(/no .blend file/);
  });
});
