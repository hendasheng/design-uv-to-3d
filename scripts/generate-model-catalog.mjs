import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const modelsDir = path.join(rootDir, 'public', 'models');
const outputPath = path.join(rootDir, 'src', 'generatedModelCatalog.ts');
const modelExtensions = new Set(['.glb']);
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);

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

async function buildCatalog() {
  const rootImages = await findImagesInDir(modelsDir);
  const fallbackUv = rootImages.find((imagePath) => /uv/i.test(path.basename(imagePath))) ?? rootImages[0];
  const entries = await getDirEntries(modelsDir);
  const groups = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

  const models = [];

  for (const group of groups) {
    const groupDir = path.join(modelsDir, group.name);
    const groupEntries = await getDirEntries(groupDir);
    const groupImages = await findImagesInDir(groupDir);
    const groupUv = groupImages.find((imagePath) => /uv/i.test(path.basename(imagePath))) ?? groupImages[0] ?? fallbackUv;
    const glbFiles = groupEntries
      .filter((entry) => entry.isFile() && modelExtensions.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.join(groupDir, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'zh-Hans-CN'));

    for (const glbPath of glbFiles) {
      const relativePath = path.relative(modelsDir, glbPath);
      models.push({
        id: `model-${hashPath(relativePath)}`,
        name: nameWithoutExtension(path.basename(glbPath)),
        groupName: group.name,
        fileName: path.basename(glbPath),
        path: toPublicPath(glbPath),
        uvImageFileName: groupUv ? path.basename(groupUv) : undefined,
        uvImagePath: groupUv ? toPublicPath(groupUv) : undefined,
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
