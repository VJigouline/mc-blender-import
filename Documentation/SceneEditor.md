# Using it in SceneEditor

[SceneEditor](https://github.com/VJigouline/SceneEditor) opens .blend files with mc-blender-import. Drop a `.blend` file on the view, or choose one with **Open files** on the Scene tab.

## Images

Images packed into the .blend file need nothing else; in Blender, File ▸ External Data ▸ Pack Resources packs them. Other images must be given with the file, in one of these ways:

- **A folder:** drop the folder that holds the .blend file and its images.
- **Several files:** drop the .blend file and its images together, or choose them together with **Open files**.
- **A zip:** drop or open a zip of the .blend file and its images.

Images are found by file name, wherever they are.

A zip that holds a .blend file is opened with mc-blender-import; other zips are opened as Ogre resources with [mc-ogre-import](https://github.com/VJigouline/mc-ogre-import). Each .blend file dropped together is opened as a model of its own.

`ThreeSceneService.addBlendFile` passes the file and the images to `loadBlend`, adds the resulting group to the scene, then refits the view.

## Errors and warnings

- **Failure messages:** a file that isn't a .blend file, or one with no meshes SceneEditor can show, gives a **Failure** message, and the scene is unaffected.
- **Console warnings:** these go to the browser console, with the Blender version that saved the file. They include images that were not found, modifiers that were not applied, and object types that are not read.

## The model in the editor

- **Units and axes:** the model comes in metres with Y up, like the other formats.
- **Structure:** objects keep their names and parenting, and collection instances are groups.
- **Materials:** these are MeshStandardMaterials (MeshPhysicalMaterials where they use transmission, coat or sheen). They can be edited and reassigned on the Materials tab like any other.
- **Lights:** the file's lights and world colour are added with the model, besides SceneEditor's own lights.
- **Metallic materials:** they look dark, as with other formats, because SceneEditor has no environment map for them to reflect.

## Tested models

These scenes from Khronos's glTF-Blender-IO tests open and display correctly in SceneEditor:

- **`01_principled_material`:** saved by Blender 2.79, with its four textures beside it.
- **`39_parenting_full_hierarchy`:** saved by Blender 5.2, with parenting and nested collection instances.
