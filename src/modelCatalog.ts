import { generatedModelCatalog } from './generatedModelCatalog';

export type ModelEntry = {
  id: string;
  name: string;
  groupName: string;
  fileName: string;
  path: string;
  parts?: ModelPartEntry[];
  uvImages?: UvImageEntry[];
  uvImageFileName?: string;
  uvImagePath?: string;
};

export type ModelPartEntry = {
  fileName: string;
  name: string;
  path: string;
};

export type UvImageEntry = {
  fileName: string;
  name: string;
  path: string;
};

const modelAssetBaseUrl = window.__MODEL_ASSET_BASE_URL__?.trim().replace(/\/+$/, '') ?? '';
const modelAssetPathRewrites = Object.entries(window.__MODEL_ASSET_PATH_REWRITES__ ?? {})
  .map(([fromPath, toUrl]) => [fromPath.replace(/^\/?models\/?/, '').replace(/^\/+/, ''), toUrl.trim().replace(/\/+$/, '')] as const)
  .filter(([, toUrl]) => toUrl)
  .sort(([leftPath], [rightPath]) => rightPath.length - leftPath.length);

function resolveModelAssetPath(assetPath: string) {
  if (/^https?:\/\//i.test(assetPath)) {
    return assetPath;
  }

  const relativePath = assetPath.replace(/^\/models\/?/, '').replace(/^\/+/, '');

  for (const [fromPath, toUrl] of modelAssetPathRewrites) {
    if (relativePath.startsWith(fromPath)) {
      return `${toUrl}/${relativePath.slice(fromPath.length)}`;
    }
  }

  if (!modelAssetBaseUrl) {
    return assetPath;
  }

  return `${modelAssetBaseUrl}/${relativePath}`;
}

function resolveUvImageEntry(uvImage: UvImageEntry): UvImageEntry {
  return {
    ...uvImage,
    path: resolveModelAssetPath(uvImage.path),
  };
}

function resolveModelEntry(model: ModelEntry): ModelEntry {
  return {
    ...model,
    path: resolveModelAssetPath(model.path),
    parts: model.parts?.map((part) => ({
      ...part,
      path: resolveModelAssetPath(part.path),
    })),
    uvImages: model.uvImages?.map(resolveUvImageEntry),
    uvImagePath: model.uvImagePath ? resolveModelAssetPath(model.uvImagePath) : undefined,
  };
}

export const modelCatalog: ModelEntry[] = generatedModelCatalog.map(resolveModelEntry);
