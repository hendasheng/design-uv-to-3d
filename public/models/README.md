# Models Folder

Put GLB files in product folders, and put shared UV reference images in this folder or in each product folder.

The app scans this folder and generates `src/generatedModelCatalog.ts` automatically when you run `npm run dev`, `npm run build`, or `npm run generate:models`.

Recommended structure:

```text
public/models/
  shared-uv.png
  product-a/
    model-01.glb
    model-02.glb
  product-b/
    model-01.glb
    product-b-uv.png
```

Each direct child folder under `public/models` becomes a group in the left model list.

UV image detection:

- If a product folder contains an image file, that image is used for models in that folder.
- If the product folder has no image, the app falls back to a root-level image in `public/models`.
