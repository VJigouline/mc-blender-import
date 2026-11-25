# API

## Loading

### `loadBlend(input, options?)`

Reads a .blend file into three.js, and returns `Promise<BlendLoadResult>`.

`input` is one of:

- the file's bytes, as an `ArrayBuffer` or `Uint8Array`;
- a file, or an iterable of files: browser `File` objects or `{ name, data }`, where `data` is a string, `ArrayBuffer`, `Uint8Array` or `Blob`. Zip archives are opened and their files used as if given one by one.

`options` is a `BlendLoadOptions`: every option of [`BlendThreeOptions`](#blendthreeoptions), and these:

| Option | Meaning |
| --- | --- |
| `main` | The .blend file to open, if several are given. By default, the first. |
| `resolve` | `(path) => Promise<data \| null>`. It fetches images that are neither packed nor among the files. |

It throws `BlendImportError` if there's no .blend file, and `BlendFileError` if the file can't be read. Problems inside the file become warnings.

### `loadBlendFromUrl(url, options?)`

Fetches a .blend file, and its images from the paths it gives, relative to its URL. It takes the [`BlendThreeOptions`](#blendthreeoptions), and `fetch` to use instead of the global `fetch`.

### `BlendLoadResult`

| Field | Type | Meaning |
| --- | --- | --- |
| `group` | `THREE.Group` | The scene, in metres, Y up. |
| `version` | `number` | The Blender version that saved the file, such as `279` or `502`. |
| `camera` | `THREE.Camera \| null` | The scene's active camera, if it was added. |
| `background` | `THREE.Color \| null` | The world colour, linear. |
| `missing` | `string[]` | Images that are neither packed nor among the files. |
| `warnings` | `string[]` | Problems that didn't stop the import. |
| `stats` | `BlendBuildStats` | Counts: `objects`, `meshes`, `triangles`, `materials`, `textures`, `lights` and `cameras`. |

### `BlendThreeOptions`

| Option | Default | Meaning |
| --- | --- | --- |
| `lightIntensity` | `1` | Multiplies every light's intensity, including the world light. |
| `worldLight` | `true` | Adds the world colour as an `AmbientLight`. |
| `cameras` | `true` | Adds the scene's cameras. |
| `textures` | `true` | Loads images. |
| `textureLoader` | `defaultTextureLoader` | `(name, bytes) => Promise<THREE.Texture \| null>`. Decodes an image file. |
| `skipHidden` | `false` | Leaves out objects hidden in renders, instead of adding them hidden. |

### `BlendUserData`

Each object the importer makes has `userData.blender`, with these fields:

| Field | Meaning |
| --- | --- |
| `kind` | `scene`, `object` or `instance`. |
| `name` | The Blender name. |
| `type` | For objects: `mesh`, `light`, `camera`, `empty` and so on. |
| `data` | For meshes: the mesh's name. |

Materials have `userData.blender = { material, source }`. `source` says what the material was read from:

| Value | Read from |
| --- | --- |
| `principled` | a Principled BSDF |
| `nodes` | other shader nodes |
| `group` | a node group |
| `viewport` | the viewport colours |
| `internal` | a Blender Internal material |

## Reading the file

### `BlendFile`

`new BlendFile(bytes)` reads an uncompressed .blend file. Use `decompressBlend(bytes)` first for files that may be compressed; `isBlend`, `isZstd` and `isGzip` test bytes.

| Member | Meaning |
| --- | --- |
| `version` | The Blender version, such as `279`. |
| `pointerSize`, `littleEndian` | The layout of the file. |
| `blocks` | Every `BlendBlock`: `code`, `sdna`, `address`, `length`, `count`, `offset` and `group`. |
| `structs` | The SDNA struct layouts: `name`, `size` and `fields`. |
| `struct(name)` | A struct layout by name. |
| `blocksWithCode(code)` | Blocks with a code, such as `OB`, `ME` or `MA`. |
| `structOf(block, index?)` | A `BStruct` view of a struct in a block. |
| `at(address, type?, from?)` | A `BStruct` at an address. `from` is the block the pointer was read from. |
| `blockAt(address, from?)` | The block holding an address. |

Recent Blender versions reuse data addresses between IDs. So, as in Blender's own reader, a data pointer is looked up first among the blocks of the ID it was read from (`from`), then among IDs.

### `BStruct`

A struct in the file, read by field name. A field the struct doesn't have reads as undefined, so you can pass the names different versions use: `num('totvert', 'verts_num')`.

| Member | Meaning |
| --- | --- |
| `num(...names)` | A number field. |
| `nums(...names)` | A number array field, such as `loc` or `parentinv`, flattened. |
| `str(...names)` | A char array field as text. |
| `ptr(...names)` | A pointer field's address, `0n` for null. |
| `deref(names, type?)` | The struct a pointer points to. |
| `sub(...names)` | An embedded struct field. |
| `list(names, type?)` | The items of a `ListBase` field. |
| `idName` | The ID's name without its two-letter code. |
| `has(name)`, `field(...names)` | Whether the struct has a field, and the field's layout. |

`pointerArray(file, address, count, from?)` reads an array of pointers, such as `Material **mat`.

## Readers and builders

| Export | Meaning |
| --- | --- |
| `readMesh(file, mesh, warnings)` | Reads a `Mesh` struct into `BlendMeshData`. |
| `buildGeometry(meshData)` | Builds a `THREE.BufferGeometry` with a group per material slot. |
| `readMaterial(file, material, warnings)` | Reads a `Material` struct into `BlendMaterialData`. |
| `BlendBuilder` | Builds the three.js scene; `loadBlend` is a thin layer over it. |
| `defaultTextureLoader` | The default image decoder. |
| `BlendResources` | A set of files looked up by name, ignoring case and folders. |
| `readZip`, `isZip` | List and inflate zip archives. |

`BlendMeshData` holds these fields:

- **Geometry:** `positions` per vertex; `faceOffsets` and `cornerVerts` for the faces; `materialIndex` and `smooth` per face.
- **Shading:** `autoSmoothAngle`.
- **Per corner:** `uvs` and `colors`.
- **Other:** the mesh's `materials` and its `looseEdges`.

`BlendMaterialData` holds these fields:

- **PBR values:** `baseColor`, `metallic`, `roughness`, `alpha`, `emission`, `ior`, `transmission`, `coat`, `coatRoughness`, `sheen` and `normalStrength`.
- **Textures:** `maps`.
- **Drawing:** `vertexColor`, `blend`, `alphaThreshold`, `backfaceCulling` and `unlit`.
- **Origin:** `source`.
