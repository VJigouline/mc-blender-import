# mc-blender-import

An importer for [Blender](https://www.blender.org/) `.blend` files into [three.js](https://threejs.org/), written in TypeScript. It reads the file directly, without Blender, and builds a three.js scene with the file's objects, meshes, materials, textures, lights and cameras. It was made for [SceneEditor](https://github.com/VJigouline/SceneEditor), and works in any three.js application.

```ts
import { loadBlend } from 'mc-blender-import';

const result = await loadBlend(await file.arrayBuffer());
scene.add(result.group);            // THREE.Group, in metres, Y up
console.log(result.version);        // 502 for Blender 5.2
console.log(result.warnings);       // anything that couldn't be read
```

## What it reads

- **Files** from Blender 2.5 to 5.x:
  - Uncompressed files, and files compressed with zstd (Blender 3.0 and later) or gzip (before 3.0).
  - Each file's own catalogue of struct layouts (SDNA), so fields are read by name in every version.
  - The 64-bit block headers of Blender 5.
- **Objects** of the file's current scene:
  - Their parenting, transforms and every rotation mode.
  - Collections and collection instances.
  - Objects hidden in renders, which are added but not visible.
- **Meshes** in all three of Blender's storage styles: the structs before 3.5, the named attributes of 3.5 to 4.x, and the attribute storage of 5.0 on. That covers:
  - Faces of any size, including concave ones, and material slots.
  - Flat and smooth shading, with the auto smooth angle used before 4.1.
  - UV maps and colour attributes.
- **Materials:**
  - The Principled BSDF: base colour, metallic, roughness, alpha, emission, IOR, transmission, coat and sheen.
  - Diffuse, Glossy, Glass, Emission and Transparent shaders, and Mix and Add shaders between them.
  - Node groups with PBR inputs, such as those of the older glTF exporter.
  - Image textures for base colour, metallic, roughness, normal maps, emission and alpha, through Normal Map and Separate RGB/Color nodes.
  - Blend modes and backface culling.
  - Blender Internal materials from files before 2.80.
- **Images:** packed into the file, or given beside it. PNG, JPEG, GIF, BMP, WebP and AVIF in browsers, and TGA anywhere.
- **Lights:** point, sun, spot and area lights in watts. Blender Internal lamps, with their falloff.
- **Cameras:** perspective and orthographic, with the lens, sensor fit and clipping.
- **World:** the world colour, added as ambient light.

Modifiers, armatures and animation, shape keys, curves, text, grease pencil and other object types are not read; the file's warnings say which were left out. See [Formats and support](Documentation/Support.md) for the details, the limits, and which versions are tested.

## Install

The package is not on the npm registry. Install it from GitHub:

```sh
npm install github:VJigouline/mc-blender-import
```

`three` (r160 or later) is a peer dependency. The package depends on [fzstd](https://github.com/101arrowz/fzstd) to inflate zstd-compressed files, and builds itself on install.

## Documentation

- [Getting started](Documentation/GettingStarted.md)
- [API](Documentation/API.md)
- [Formats and support](Documentation/Support.md)

## Development

```sh
npm install
npm test           # unit tests, with Vitest
npm run typecheck
npm run build      # dist/
```

The tests load real .blend files saved by Blender 2.78, 2.79, 2.91 and 5.2, kept in [`tests/samples`](tests/samples/README.md) with their licence. It needs Node.js 22 or later.

## Licence

[MIT](LICENSE)
