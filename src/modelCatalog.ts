import { generatedModelCatalog } from './generatedModelCatalog';

export type ModelEntry = {
  id: string;
  name: string;
  groupName: string;
  fileName: string;
  path: string;
  uvImages?: UvImageEntry[];
  uvImageFileName?: string;
  uvImagePath?: string;
};

export type UvImageEntry = {
  fileName: string;
  name: string;
  path: string;
};

export const modelCatalog: ModelEntry[] = generatedModelCatalog;
