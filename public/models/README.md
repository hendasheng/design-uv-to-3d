# Models Folder

Put GLB files in product folders, and put shared UV reference images in this folder or in each product folder.

The app scans this folder and generates `src/generatedModelCatalog.ts` automatically when you run `npm run dev`, `npm run build`, or `npm run generate:models`.

Recommended structure:

```text
public/models/
  uv/
    shared-uv.png
    alternate-uv.png
  product-a/
    model-01.glb
    model-02.glb
  product-b/
    model-01.glb
    product-b-uv.png
```

Each direct child folder under `public/models` becomes a group in the left model list, except `public/models/uv`.

Multi-part models: files named as `number_sequence_name` (e.g. `02_01_badge.glb`, `02_02_badge.glb`) sharing the same leading number are merged into one model entry and shown side by side in the 3D view.

UV image detection:

- If a product folder contains an image file, that image is used for models in that folder.
- Images in `public/models/uv` are added as shared UV references and can be switched in the UI.
