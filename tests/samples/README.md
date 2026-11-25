# Blender test scenes

Real .blend files that the tests load, saved by Blender 2.78, 2.79, 2.91 and 5.2, with the images they use.

They come unchanged from [tests/scenes](https://github.com/KhronosGroup/glTF-Blender-IO/tree/main/tests/scenes) in Khronos's glTF-Blender-IO repository, as of commit `04ef1f08ad` (21 November 2026). They are licensed under the [Apache License 2.0](https://github.com/KhronosGroup/glTF-Blender-IO/blob/main/LICENSE.txt), copyright The Khronos Group Inc. and the glTF-Blender-IO authors.

| File | Blender | What it covers |
| --- | --- | --- |
| `01_cube`, `01_triangle` | 2.78 | A mesh with a glTF node-group material |
| `02_shared_mesh` | 2.78 | Two objects sharing one mesh |
| `02_node_hierarchy` | 2.78 | A parented object |
| `04_lights` | 2.78 | Sun, point and spot lamps with constant, linear and quadratic falloff |
| `01_principled_material` | 2.79 | Principled BSDF with base colour, metallic-roughness, normal and emission textures |
| `01_textured_sphere` | 2.78 | Textures through a node group |
| `01_alpha_blend` | 2.78 | Alpha blending |
| `01_color_attribute` | 2.78 | Vertex colours |
| `11_loose_geometry` | 2.91 | Loose vertices and edges beside faces |
| `01_bump_normal_map` | 5.2 | Bump and Normal Map nodes; zstd-compressed |
| `37_lamp_EEVEE` | 5.2 | A point light in watts; zstd-compressed |
| `39_parenting_full_hierarchy` | 5.2 | Parenting and nested collection instances; zstd-compressed |
| `01_dispersion` | 5.2 | Transmission; zstd-compressed |

These files keep their own licence. They are test data only, and are not part of the npm package, which includes only `dist`, `Documentation`, `README.md` and `LICENSE`.
