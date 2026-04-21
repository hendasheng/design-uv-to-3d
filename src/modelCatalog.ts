import { generatedModelCatalog } from './generatedModelCatalog';

export type ModelEntry = {
  id: string;
  name: string;
  groupName: string;
  fileName: string;
  path: string;
  uvImageFileName?: string;
  uvImagePath?: string;
};

export const modelCatalog: ModelEntry[] = generatedModelCatalog;
