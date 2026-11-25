# Formats and support

## Tested versions

The tests load files saved by **Blender 2.78, 2.79, 2.91 and 5.2** (see [tests/samples](../tests/samples/README.md)). Between them they cover uncompressed and zstd-compressed files, both block header layouts, and the oldest and newest ways of storing meshes.

The reader is written for every version from 2.5 on, but these parts are not yet tested with real files:

- **Blender 3.5 to 4.x meshes:** named attributes in CustomData layers.
- **Meshes from before 2.63:** tessellated MFace faces.
- **Rare file layouts:** files with 4-byte pointers or in big-endian byte order.

## The file

A .blend file is a memory dump of Blender's data, in blocks. The reader handles these parts:

- **Header:** the 12-byte header of Blender 2.x to 4.x, and the 17-byte header of 5.0 and later.
- **Blocks:** 20- and 24-byte block headers, and the 32-byte headers with 64-bit lengths that Blender 5 uses.
- **SDNA:** the catalogue of struct layouts each file carries. Every struct is read by field name through it, so renamed or moved fields are found by trying each name Blender has used.
- **Pointers:** they hold the addresses data had when the file was saved. As in Blender's reader, a data pointer is resolved among the blocks of the ID it is read from, because recent versions reuse addresses between IDs.
- **Compression:** zstd (Blender 3.0 and later), with [fzstd](https://github.com/101arrowz/fzstd), and gzip (before 3.0), with the platform's DecompressionStream.

## Scenes and objects

- **Scene:** the file's current scene is read; without one, its first.
- **Objects in the scene:** from its collections (2.80 on) or its bases (before 2.80).
- **Transforms:** location, rotation and scale, with their deltas, in every rotation mode: quaternion, axis-angle and the six Euler orders.
- **Parenting:** parenting to objects, with the parent inverse matrix. Parenting to bones and vertices is read as parenting to the object.
- **Collection instances:** an empty that instances a collection gets a copy of the collection's objects, offset by the collection's instance offset. Instances may nest.
- **Hidden objects:** objects hidden in renders are added with `visible = false`, or left out with `skipHidden`.
- **Axes and units:** the scene is turned from Z up to Y up, and scaled by the scene's unit scale.
- **Not read:**
  - Modifiers: meshes are shown without them, with a warning that names them.
  - Armatures, constraints, drivers, animation and shape keys.
  - Curves, surfaces, text, metaballs, grease pencil, point clouds, volumes, lattices and particles.
  - Linked libraries.

## Meshes

| Data | Blender before 3.5 | 3.5 to 4.x | 5.0 and later |
| --- | --- | --- | --- |
| Positions | MVert structs | `position` attribute | `position` in AttributeStorage |
| Faces | MPoly and MLoop (MFace before 2.63) | `poly_offset_indices` and `.corner_vert` | the same, in AttributeStorage |
| Material slot | `MPoly.mat_nr` | `material_index` | `material_index` |
| Shading | `MPoly` smooth flag | `sharp_face` | `sharp_face` |
| UV maps | MLoopUV layers | float2 corner attributes | float2 corner attributes |
| Colours | MLoopCol layers | colour attributes | colour attributes |

Faces of three and four corners are split as Blender splits them; larger faces, including concave ones, are ear-clipped. Normals follow Blender's shading:

- **Flat faces** get their face normal.
- **Smooth faces** get an angle-weighted vertex normal. In files before 4.1 that use auto smooth, faces at a sharper angle than its limit stay apart.

Sharp edges, custom split normals and the "Smooth by Angle" modifier of 4.1 and later are not applied.

Loose vertices and edges are not drawn, as Blender doesn't render them. Up to four UV maps are kept, in the file's order, with the default UV map first in files that name it (5.0 and later).

## Materials

### Node materials

The shader connected to the Material Output's Surface is read:

| Node | three.js |
| --- | --- |
| Principled BSDF | `MeshStandardMaterial`, or `MeshPhysicalMaterial` with transmission, coat or sheen |
| Diffuse BSDF | roughness 1 |
| Glossy, Anisotropic and Metallic BSDF | metalness 1 |
| Glass and Refraction BSDF | transmission 1 |
| Emission alone | `MeshBasicMaterial` |
| Transparent BSDF mixed with a shader | the shader, with the mix factor as opacity |
| Mix Shader | the shader with the larger share, with a warning |
| Add Shader | both, such as a BSDF plus emission |
| Node groups | read by input names, as described below |

Input values come from the socket or from what is linked to it:

- **Image Texture nodes** give textures. Their Alpha output gives an alpha texture.
- **Separate RGB/Color/XYZ nodes** pick a texture channel.
- **Normal Map nodes** give the normal map and its strength.
- **RGB and Value nodes** give constants; **Vertex Color and Attribute nodes** turn on vertex colours.
- **Mix, Gamma, Hue/Saturation, Bright/Contrast, RGB Curves, Invert and Math nodes** are not evaluated. The first texture or colour feeding them is used, with a warning.
- **Bump nodes and Mapping nodes** are not applied, with a warning.

**Node groups** whose inputs are named like PBR parameters are read by those names, matched without case, spaces or underscores:

- Base Color, or BaseColor with BaseColorFactor;
- Metallic and Roughness, or a MetallicRoughness texture;
- Normal;
- Emissive or Emission;
- Alpha.

This covers the PBR groups of the older glTF exporter.

**Texture channels:** three.js reads roughness from the green channel and metalness from the blue, as glTF does. A roughness or metallic value taken from another channel gives a warning.

### Material settings

| Setting | three.js |
| --- | --- |
| Blend mode Alpha Blend (before 4.2), or render method Blended (4.2 on) | `transparent` |
| Alpha Clip, with its threshold | `alphaTest` |
| Alpha Hashed, or the Dithered render method with alpha | `alphaHash` |
| Backface Culling | `FrontSide`; otherwise `DoubleSide`, as Blender renders both sides |

### Materials without nodes

- **2.80 and later:** materials without nodes use their viewport colour, metallic and roughness.
- **Before 2.80:** Blender Internal materials give these:
  - diffuse colour;
  - alpha, when transparency is on;
  - roughness from the specular hardness;
  - emission;
  - image textures mapped to colour, normal or alpha.

### Colours and images

- **Colours:** Blender stores colours as linear values, and they are used as they are. Byte colour attributes are stored in sRGB and are converted.
- **Image colour space:** each image's colour space setting decides whether it is read as sRGB or as data. Normal, roughness and metallic maps are always read as data.
- **Packed images** are read from the file.
- **Other images** are looked for by their path, then by their file name, among the files given or through `resolve`.
- **Orientation:** Blender's texture coordinates start at the bottom left, so the default loader decodes images flipped, as three.js expects.

## Lights

| Blender | three.js |
| --- | --- |
| Point | `PointLight` |
| Sun | `DirectionalLight` |
| Spot | `SpotLight`. Its `angle` is half the spot size, and its `penumbra` is the spot blend. |
| Area | `PointLight`, with a warning |
| Hemi (before 2.80) | `DirectionalLight` |

Lights point down their object's −Z axis, as in Blender. Directional and spot lights carry their target as a child.

**Intensity, 2.80 and later.** Blender gives light power in watts. A point or spot light of P watts has a radiant intensity of P / 4π, and a sun's strength is the irradiance it gives. three.js uses the same quantities with its default physically based lighting, so:

- point, spot and area lights get an intensity of P / 4π, with inverse-square falloff;
- suns keep their strength.

A 1000 W point light 4 m from a surface then lights it like a sun of strength 5, as in Blender. Use `lightIntensity` to scale every light.

**Intensity, before 2.80.** Blender Internal lamps had a unitless energy E and a distance d:

| Falloff | three.js intensity | Decay |
| --- | --- | --- |
| Constant | E·π | 0 |
| Inverse linear | E·π·d | 1 |
| Inverse square, and the other falloffs | E·π·d² | 2 |

So each lamp gives its energy at its distance, as in Blender Internal. Cycles lamp nodes of those versions are not read.

**World:** a uniform world colour L lights a matte surface like an ambient light of L·π. It is added as an `AmbientLight`, with the colour and strength of the world's Background node, or the horizon colour of older files. World textures and HDR images are not read.

## Cameras

| Camera | three.js |
| --- | --- |
| Perspective | `PerspectiveCamera`, with the field of view from the focal length, sensor size and sensor fit, and the aspect ratio from the scene's render resolution |
| Orthographic | `OrthographicCamera`, with the orthographic scale across the wider side |
| Panoramic | `PerspectiveCamera`, with a warning |

Clip start and end become `near` and `far`. Shift, depth of field and stereo settings are not read.
