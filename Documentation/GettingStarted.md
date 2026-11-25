# Getting started

## Install

```sh
npm install three github:VJigouline/mc-blender-import
```

## Open a .blend file

Pass the file's bytes to `loadBlend`:

```ts
import * as THREE from 'three';
import { loadBlend } from 'mc-blender-import';

const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
input.addEventListener('change', async () => {
  const file = input.files![0]!;
  const result = await loadBlend(await file.arrayBuffer());
  scene.add(result.group);
  for (const warning of result.warnings) console.warn(warning);
});
```

Compressed files (zstd from Blender 3.0 on, gzip before) are inflated as they are read.

## Images beside the file

Images packed into the .blend file (File ▸ External Data ▸ Pack Resources in Blender) need nothing else. Other images are files beside the .blend file, so pass them too, or a zip of everything. Images are found by file name, wherever they are, because Blender's relative paths often no longer match once a model is moved:

```ts
const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
input.multiple = true;
input.accept = '.blend,.png,.jpg,.jpeg,.tga,.zip';

input.addEventListener('change', async () => {
  const result = await loadBlend(input.files!);
  scene.add(result.group);
  if (result.missing.length) console.warn('Images not found:', result.missing);
});
```

Browser `File` objects can be passed as they are; otherwise pass `{ name, data }` objects. The first .blend file is opened; name another with `main`.

To fetch a .blend file and its images from a server, use `loadBlendFromUrl('/models/room.blend')`. Images are fetched from the paths the file gives, relative to its URL.

## What you get

- **`group`:** a `THREE.Group` holding the scene. Its rotation turns Blender's Z up into three.js's Y up, and its scale applies the scene's unit scale.
- **Objects:** each Blender object is a `THREE.Group` with the object's name and transform. Children are nested under their parents.
- **Inside each object:**
  - Meshes: one `THREE.Mesh`, with a material for each slot it uses.
  - Lights and cameras.
  - Collection instances: a group holding a copy of the collection's objects.
- **`userData.blender`:** on each object, it records the object's name and type, and on meshes, the mesh's name. Materials have `userData.blender` with the material's name.
- **`camera`:** the scene's active camera, if it has one. To look through it:

  ```ts
  result.group.updateMatrixWorld(true);
  viewCamera.position.copy(result.camera.getWorldPosition(new THREE.Vector3()));
  viewCamera.quaternion.copy(result.camera.getWorldQuaternion(new THREE.Quaternion()));
  ```

- **`background`:** the world colour, linear, for `scene.background` if you want it.

## Lighting

Lights are converted so that a three.js scene with its default physically based lighting looks about as in Blender: a light of P watts gets an intensity of P / 4π, and a sun keeps its strength. Use a tone mapping such as `THREE.AgXToneMapping`, which Blender also uses by default, for a similar look.

Metallic materials reflect their surroundings, so they look black without an environment map. Set `scene.environment`, for example from three.js's `RoomEnvironment`, as you would for any physically based scene.

## Options

```ts
await loadBlend(bytes, {
  lightIntensity: 1,   // multiplies every light
  worldLight: true,    // add the world colour as an AmbientLight
  cameras: true,       // add the scene's cameras
  textures: true,      // load images
  skipHidden: false,   // leave out objects hidden in renders, instead of adding them hidden
});
```

To decode images yourself, such as EXR or KTX2, pass `textureLoader: async (name, bytes) => texture`. Return a texture whose rows run as Blender expects, bottom first, or null if you can't decode the image.

## Lower-level access

`BlendFile` reads any .blend file's structure, and `BStruct` reads its structs by field name. They can be used for data the importer doesn't read:

```ts
import { BlendFile, decompressBlend } from 'mc-blender-import';

const file = new BlendFile(await decompressBlend(new Uint8Array(bytes)));
for (const block of file.blocksWithCode('OB')) {
  const object = file.structOf(block)!;
  console.log(object.idName, object.nums('loc'));
}
```

See the [API](API.md) for everything the package exports.
