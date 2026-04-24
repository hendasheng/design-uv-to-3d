# Design UV to 3D

一个用于检查设计稿在 3D 产品模型上贴合效果的轻量 3D 查看工具。

它支持颜色、金属、凹凸和透明贴图预览，帮助平面设计师快速确认图案位置与材质细节，降低平面设计稿与 3D 成品之间的沟通误差，减少返工并提升确认效率。

项目基于 React、Vite、Three.js、`@react-three/fiber` 和 `@react-three/drei` 构建。应用会自动扫描 `public/models` 目录生成模型列表，支持在浏览器中查看 GLB 模型、切换固定视角、拖拽上传贴图，并对照 UV 参考图检查图案位置。

## 功能

- 自动扫描 `public/models` 下的产品文件夹并生成模型目录
- 按产品文件夹分组展示 GLB 模型
- 支持旋转、平移、缩放查看 3D 模型
- 支持前、后、左、右、顶、底固定视角
- 支持显示或隐藏网格
- 支持拖拽或手动上传颜色、金属、凹凸和透明贴图进行预览
- 支持 PNG/WebP 等带透明通道贴图，并可切换透明处理方式
- 左侧模型列表、中央 3D 视图、右侧 UV 参考图联动查看

## 目录结构

```text
public/models/
  示例模型/
    01.glb
  示例 UV/
    01_UV.png
  uv/
    Blender_UV.png
  README.md
  产品文件夹/
    本地模型.glb
src/
  main.tsx
  modelCatalog.ts
  styles.css
  viewer/
    ModelViewer.tsx
scripts/
  generate-model-catalog.mjs
```

## 环境要求

- Node.js 20 或更新版本
- npm

## 本地运行

安装依赖：

```bash
npm install
```

启动开发服务器：

```bash
npm run dev
```

构建生产版本：

```bash
npm run build
```

预览生产构建：

```bash
npm run preview
```

## 示例资源

- 仓库自带 `示例模型` 和 `示例 UV`
- 它们是功能示例，方便初次使用时理解基本用法
- 除这两组外，其他业务模型仍建议本地管理
- 首次打开时，可以先用这两组资源体验基本查看、贴图上传和 UV 对照流程

## 模型目录规则

模型目录由脚本自动生成：

```bash
npm run generate:models
```

`npm run dev` 和 `npm run build` 会在启动或构建前自动执行该脚本。

规则如下：

- `public/models` 下的每一个直接子文件夹会成为一个模型分组。
- `public/models/uv` 是全局 UV 参考图库，不会成为模型分组。
- 分组文件夹中的每一个 `.glb` 文件会成为一个可选择的模型。
- 如果分组文件夹中有图片文件，会优先作为该分组模型的 UV 参考图选项。
- `public/models/uv` 下的图片会作为全局 UV 参考图选项，界面中可切换查看。
- 文件路径会自动进行 URL 编码，支持中文文件夹名和文件名。
- `.glb` 模型文件默认不会提交到 Git 仓库，请在本地或部署环境中自行放入 `public/models`。
- 例外：`public/models/示例模型` 和 `public/models/示例 UV` 会随仓库提交，作为首次使用时的功能示例。

## 添加新模型

1. 在 `public/models` 下创建一个产品文件夹，例如 `public/models/新产品`。
2. 将一个或多个 `.glb` 文件放入该文件夹。
3. 可选：将对应的 UV 参考图放入同一个产品文件夹，或放入 `public/models/uv` 作为全局参考图。
4. 运行 `npm run dev` 或 `npm run generate:models` 重新生成目录。

## 使用说明

- 左侧选择模型分组和具体模型。
- 中央区域查看 3D 模型，可使用鼠标旋转、平移和缩放。
- 点击视角按钮可快速切换前、后、左、右、顶、底视图。
- 将贴图图片拖入查看区域，或点击上传按钮选择图片，即可将贴图应用到当前模型。
- 右侧可切换当前模型关联的 UV 参考图，用于对照图案位置。

## 注意事项

- 建议压缩 GLB 和贴图资源，避免浏览器加载过慢。
- `src/generatedModelCatalog.ts` 是自动生成文件，不需要手动维护。
- 默认 UV 参考图位于 `public/models/uv`，模型文件可以按项目需要在本地替换或扩展。
- 除 `示例模型` 和 `示例 UV` 外，其他业务模型默认仍按本地资源处理，不建议直接提交大体积 GLB 到仓库。
