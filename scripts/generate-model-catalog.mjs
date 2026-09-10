import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const modelsDir = path.join(rootDir, 'public', 'models');
const sharedUvDirName = 'uv';
const sharedUvDir = path.join(modelsDir, sharedUvDirName);
const outputPath = path.join(rootDir, 'src', 'generatedModelCatalog.ts');
const modelExtensions = new Set(['.glb']);
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const prioritizedGroupNames = new Set(['示例', '示例模型']);

function toPublicPath(filePath) {
  return `/${path.relative(path.join(rootDir, 'public'), filePath).split(path.sep).map(encodeURIComponent).join('/')}`;
}

function hashPath(value) {
  let hash = 5381;
  for (const char of value) {
    hash = (hash * 33) ^ char.charCodeAt(0);
  }
  return (hash >>> 0).toString(36);
}

function nameWithoutExtension(fileName) {
  return fileName.replace(/\.[^.]+$/, '');
}

function getSequenceInfo(fileName) {
  const name = nameWithoutExtension(fileName);
  const match = name.match(/^(\d+)_\d+_(.+)$/);

  if (!match) {
    return null;
  }

  return {
    rootNumber: match[1],
    suffix: match[2],
  };
}

function getCommonPrefix(values) {
  if (values.length === 0) {
    return '';
  }

  let prefix = values[0];

  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }

  return prefix.replace(/[_\-\s]+$/g, '');
}

function getModelPartLabel(fileName) {
  return nameWithoutExtension(fileName).match(/^\d+_\d+/)?.[0] ?? nameWithoutExtension(fileName);
}

function toUvEntry(imagePath) {
  const fileName = path.basename(imagePath);

  return {
    fileName,
    name: nameWithoutExtension(fileName),
    path: toPublicPath(imagePath),
  };
}

async function getDirEntries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function findImagesInDir(dir) {
  const entries = await getDirEntries(dir);
  return entries
    .filter((entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function compareGroupEntries(a, b) {
  const aPriority = prioritizedGroupNames.has(a.name) ? 0 : 1;
  const bPriority = prioritizedGroupNames.has(b.name) ? 0 : 1;

  if (aPriority !== bPriority) {
    return aPriority - bPriority;
  }

  return a.name.localeCompare(b.name, 'zh-Hans-CN');
}

async function buildCatalog() {
  const rootImages = await findImagesInDir(modelsDir);
  const sharedUvImages = await findImagesInDir(sharedUvDir);
  const sharedUvEntries = sharedUvImages.map(toUvEntry);
  const fallbackUv =
    sharedUvEntries.find((uvImage) => /uv/i.test(uvImage.fileName)) ??
    sharedUvEntries[0] ??
    rootImages.map(toUvEntry).find((uvImage) => /uv/i.test(uvImage.fileName)) ??
    rootImages.map(toUvEntry)[0];
  const entries = await getDirEntries(modelsDir);
  const groups = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== sharedUvDirName)
    .sort(compareGroupEntries);

  const models = [];

  for (const group of groups) {
    const groupDir = path.join(modelsDir, group.name);
    const groupEntries = await getDirEntries(groupDir);
    const groupImages = await findImagesInDir(groupDir);
    const groupUvEntries = groupImages.map(toUvEntry);
    const uvImages = [...groupUvEntries, ...sharedUvEntries];
    const groupUv =
      uvImages.find((uvImage) => /uv/i.test(uvImage.fileName)) ??
      uvImages[0] ??
      fallbackUv;
    const glbFiles = groupEntries
      .filter((entry) => entry.isFile() && modelExtensions.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.join(groupDir, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'zh-Hans-CN'));

    const modelSets = new Map();

    for (const glbPath of glbFiles) {
      const sequenceInfo = getSequenceInfo(path.basename(glbPath));
      const setKey = sequenceInfo ? `sequence:${sequenceInfo.rootNumber}` : `single:${path.basename(glbPath)}`;
      const modelSet = modelSets.get(setKey) ?? {
        files: [],
        rootNumber: sequenceInfo?.rootNumber,
        suffixes: [],
      };

      modelSet.files.push(glbPath);

      if (sequenceInfo) {
        modelSet.suffixes.push(sequenceInfo.suffix);
      }

      modelSets.set(setKey, modelSet);
    }

    for (const modelSet of modelSets.values()) {
      const firstGlbPath = modelSet.files[0];
      const firstRelativePath = path.relative(modelsDir, firstGlbPath);
      const parts = modelSet.files.map((glbPath) => ({
        fileName: path.basename(glbPath),
        name: nameWithoutExtension(path.basename(glbPath)),
        path: toPublicPath(glbPath),
      }));
      const commonName = modelSet.rootNumber ? getCommonPrefix(modelSet.suffixes) : '';
      const displayName =
        parts.length > 1 && modelSet.rootNumber
          ? [modelSet.rootNumber, commonName].filter(Boolean).join('_')
          : nameWithoutExtension(path.basename(firstGlbPath));
      const fileName =
        parts.length > 1
          ? `${parts.length} 个模型：\n${parts.map((part) => getModelPartLabel(part.fileName)).join(' / ')}`
          : path.basename(firstGlbPath);
      const relativePath =
        parts.length > 1
          ? modelSet.files.map((glbPath) => path.relative(modelsDir, glbPath)).join('|')
          : firstRelativePath;

      models.push({
        id: `model-${hashPath(relativePath)}`,
        name: displayName,
        groupName: group.name,
        fileName,
        path: toPublicPath(firstGlbPath),
        ...(parts.length > 1 ? { parts } : {}),
        uvImages,
        uvImageFileName: groupUv?.fileName,
        uvImagePath: groupUv?.path,
      });
    }
  }

  return models;
}

function serializeValue(value) {
  return JSON.stringify(value, null, 2).replace(/"([^"]+)":/g, '$1:');
}

async function main() {
  const models = await buildCatalog();
  const source = `import type { ModelEntry } from './modelCatalog';

export const generatedModelCatalog: ModelEntry[] = ${serializeValue(models)};
`;

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source);
  console.log(`Generated ${models.length} model entries in ${path.relative(rootDir, outputPath)}`);
}

await main();
