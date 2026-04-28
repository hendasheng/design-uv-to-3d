import { Canvas, useThree } from '@react-three/fiber';
import { Bounds, Center, Environment, Grid, Html, OrbitControls, useBounds, useGLTF } from '@react-three/drei';
import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, PointerEvent } from 'react';
import type { ReactNode } from 'react';
import { Eye, Grid3X3, ImageIcon, Loader2, RotateCcw, TriangleAlert, Upload, X } from 'lucide-react';
import {
  BufferGeometry,
  Box3,
  CanvasTexture,
  Material,
  MeshStandardMaterial,
  Mesh,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  SRGBColorSpace,
  Texture,
  Vector3,
} from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { ModelEntry } from '../modelCatalog';

type ModelViewerProps = {
  models: ModelEntry[];
};

type ViewPreset = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
type TextureChannel = 'color' | 'metalness' | 'bump' | 'alpha';
type ShadingPreset = 'source' | '30' | '45' | '60' | '90';

type TextureSlot = {
  name: string | null;
  url: string | null;
};

type TextureSlots = Record<TextureChannel, TextureSlot>;

type LoadedTextureSlots = Partial<Record<TextureChannel, Texture | null>>;
type ModelCanvasPhase = 'loading' | 'ready' | 'error';
type ModelLoadingStep = 'model' | 'uv';
type UvWireframeSegments = number[];
type FaceNormal = { normalX: number; normalY: number; normalZ: number };
type MaterialSnapshot = {
  alphaMap: Texture | null;
  alphaTest: number;
  bumpMap: Texture | null;
  bumpScale: number;
  colorHex: string | null;
  depthWrite: boolean;
  map: Texture | null;
  metalness: number;
  metalnessMap: Texture | null;
  opacity: number;
  roughness: number;
  roughnessMap: Texture | null;
  transparent: boolean;
  transmission: number;
};

const viewPresetButtons: Array<{ label: string; value: ViewPreset }> = [
  { label: '前', value: 'front' },
  { label: '后', value: 'back' },
  { label: '左', value: 'left' },
  { label: '右', value: 'right' },
  { label: '顶', value: 'top' },
  { label: '底', value: 'bottom' },
];

const textureChannelOptions: Array<{ label: string; helper: string; value: TextureChannel }> = [
  { label: '颜色', helper: '基础色和图案位置', value: 'color' },
  { label: '金属', helper: '黑色有效，透明无效', value: 'metalness' },
  { label: '凹凸', helper: '黑色有效，透明无效', value: 'bump' },
  { label: '透明', helper: '黑色隐藏，透明显示', value: 'alpha' },
];

const shadingPresetOptions: Array<{ label: string; value: ShadingPreset }> = [
  { label: '原始法线', value: 'source' },
  { label: '30°', value: '30' },
  { label: '45°', value: '45' },
  { label: '60°', value: '60' },
  { label: '90°', value: '90' },
];

const emptyTextureSlots: TextureSlots = {
  color: { name: null, url: null },
  metalness: { name: null, url: null },
  bump: { name: null, url: null },
  alpha: { name: null, url: null },
};

const uvWireframeSegmentsCache = new Map<string, UvWireframeSegments>();

class ModelErrorBoundary extends Component<
  { children: ReactNode; fileName: string; onError?: (fileName: string) => void },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(previousProps: { fileName: string }) {
    if (previousProps.fileName !== this.props.fileName && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch() {
    this.props.onError?.(this.props.fileName);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Html center className="canvas-message canvas-message-error">
          <TriangleAlert size={22} aria-hidden="true" />
          Missing or invalid GLB: {this.props.fileName}
        </Html>
      );
    }

    return this.props.children;
  }
}

function getInitialModel(models: ModelEntry[]) {
  if (typeof window === 'undefined') {
    return models[0]?.id ?? '';
  }

  const hashId = window.location.hash.replace('#', '');
  return models.some((model) => model.id === hashId) ? hashId : models[0]?.id ?? '';
}

function isExampleModel(model: ModelEntry | undefined) {
  return model?.groupName === '示例' || model?.groupName === '示例模型';
}

function buildUvWireframeSegments(scene: Object3D) {
  const topologyEdges = new Map<
    string,
    {
      faces: FaceNormal[];
      uvEdges: Map<string, { ax: number; ay: number; bx: number; by: number; count: number }>;
    }
  >();

  scene.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.geometry) {
      return;
    }

    const geometry = mesh.geometry as BufferGeometry;
    const uv = geometry.getAttribute('uv');

    if (!uv) {
      return;
    }

    const index = geometry.getIndex();

    const position = geometry.getAttribute('position');
    const addFaceNormal = (a: number, b: number, c: number) => {
      const ax = position.getX(a);
      const ay = position.getY(a);
      const az = position.getZ(a);
      const bx = position.getX(b);
      const by = position.getY(b);
      const bz = position.getZ(b);
      const cx = position.getX(c);
      const cy = position.getY(c);
      const cz = position.getZ(c);

      const abx = bx - ax;
      const aby = by - ay;
      const abz = bz - az;
      const acx = cx - ax;
      const acy = cy - ay;
      const acz = cz - az;
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      const length = Math.hypot(nx, ny, nz) || 1;

      return {
        normalX: nx / length,
        normalY: ny / length,
        normalZ: nz / length,
      };
    };

    const addEdge = (
      a: number,
      b: number,
      ax: number,
      ay: number,
      bx: number,
      by: number,
      faceNormal: FaceNormal,
    ) => {
      const precision = 100000;
      const apx = Math.round(position.getX(a) * precision);
      const apy = Math.round(position.getY(a) * precision);
      const apz = Math.round(position.getZ(a) * precision);
      const bpx = Math.round(position.getX(b) * precision);
      const bpy = Math.round(position.getY(b) * precision);
      const bpz = Math.round(position.getZ(b) * precision);
      const topoA = `${apx},${apy},${apz}`;
      const topoB = `${bpx},${bpy},${bpz}`;
      const topologyKey = topoA < topoB ? `${topoA}|${topoB}` : `${topoB}|${topoA}`;

      const ua = `${Math.round(ax * precision)},${Math.round(ay * precision)}`;
      const ub = `${Math.round(bx * precision)},${Math.round(by * precision)}`;
      const uvKey = ua < ub ? `${ua}|${ub}` : `${ub}|${ua}`;

      const topologyEdge: {
        faces: FaceNormal[];
        uvEdges: Map<string, { ax: number; ay: number; bx: number; by: number; count: number }>;
      } = topologyEdges.get(topologyKey) ?? {
        faces: [],
        uvEdges: new Map(),
      };
      topologyEdges.set(topologyKey, topologyEdge);
      topologyEdge.faces.push(faceNormal);

      const current = topologyEdge.uvEdges.get(uvKey);
      if (current) {
        current.count += 1;
        return;
      }

      topologyEdge.uvEdges.set(uvKey, { ax, ay, bx, by, count: 1 });
    };

    const appendTriangle = (a: number, b: number, c: number) => {
      const faceNormal = addFaceNormal(a, b, c);
      const ax = uv.getX(a);
      const ay = 1 - uv.getY(a);
      const bx = uv.getX(b);
      const by = 1 - uv.getY(b);
      const cx = uv.getX(c);
      const cy = 1 - uv.getY(c);

      addEdge(a, b, ax, ay, bx, by, faceNormal);
      addEdge(b, c, bx, by, cx, cy, faceNormal);
      addEdge(c, a, cx, cy, ax, ay, faceNormal);
    };

    if (index) {
      for (let triangle = 0; triangle < index.count; triangle += 3) {
        appendTriangle(index.getX(triangle), index.getX(triangle + 1), index.getX(triangle + 2));
      }
      return;
    }

    for (let triangle = 0; triangle < uv.count; triangle += 3) {
      appendTriangle(triangle, triangle + 1, triangle + 2);
    }
  });

  const segments: number[] = [];
  topologyEdges.forEach(({ faces, uvEdges }) => {
    if (uvEdges.size > 1) {
      uvEdges.forEach((edge) => {
        segments.push(edge.ax, edge.ay, edge.bx, edge.by);
      });
      return;
    }

    const shouldKeepByBoundary = faces.length === 1;
    const shouldKeepByAngle =
      faces.length >= 2 &&
      (() => {
        const first = faces[0];
        const second = faces[1];
        const dot = first.normalX * second.normalX + first.normalY * second.normalY + first.normalZ * second.normalZ;
        return dot < 0.995;
      })();

    uvEdges.forEach((edge) => {
      if (shouldKeepByBoundary || shouldKeepByAngle || edge.count === 1) {
        segments.push(edge.ax, edge.ay, edge.bx, edge.by);
      }
    });
  });

  return segments;
}

function scheduleIdleTask(task: () => void) {
  const requestIdle =
    'requestIdleCallback' in window
      ? window.requestIdleCallback.bind(window)
      : (callback: IdleRequestCallback) => window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 16);

  return requestIdle(() => {
    task();
  });
}

function cancelIdleTask(handle: number) {
  if ('cancelIdleCallback' in window) {
    window.cancelIdleCallback(handle);
    return;
  }

  globalThis.clearTimeout(handle);
}

function applyTexturesToMaterial(
  material: Material & { userData: Record<string, unknown> },
  textures: LoadedTextureSlots,
  textureTransparencyEnabled: boolean,
) {
  const standardMaterial = material as MeshStandardMaterial & { userData: Record<string, unknown> };
  const hasPbrMapTarget =
    'map' in standardMaterial ||
    'metalnessMap' in standardMaterial ||
    'bumpMap' in standardMaterial ||
    'alphaMap' in standardMaterial;

  if (!hasPbrMapTarget) {
    material.needsUpdate = true;
    return material;
  }

  const snapshot = standardMaterial.userData.codexOriginalMaterial as MaterialSnapshot | undefined;

  if (snapshot) {
    standardMaterial.map = snapshot.map;
    standardMaterial.metalnessMap = snapshot.metalnessMap;
    standardMaterial.roughnessMap = snapshot.roughnessMap;
    standardMaterial.bumpMap = snapshot.bumpMap;
    standardMaterial.bumpScale = snapshot.bumpScale;
    standardMaterial.alphaMap = snapshot.alphaMap;
    standardMaterial.alphaTest = snapshot.alphaTest;
    standardMaterial.transparent = snapshot.transparent;
    standardMaterial.opacity = snapshot.opacity;
    standardMaterial.depthWrite = snapshot.depthWrite;
    standardMaterial.metalness = snapshot.metalness;
    standardMaterial.roughness = snapshot.roughness;
    if ('transmission' in standardMaterial) {
      (
        standardMaterial as MeshStandardMaterial & {
          transmission?: number;
        }
      ).transmission = snapshot.transmission;
    }
    if ('color' in standardMaterial && snapshot.colorHex) {
      standardMaterial.color?.set(`#${snapshot.colorHex}`);
    }
  }

  const hasBaseColorMap = 'map' in standardMaterial && Boolean(standardMaterial.map);
  const hasMetalnessMap = 'metalnessMap' in standardMaterial && Boolean(standardMaterial.metalnessMap);
  const hasRoughnessMap = 'roughnessMap' in standardMaterial && Boolean(standardMaterial.roughnessMap);
  const hasBumpMap = 'bumpMap' in standardMaterial && Boolean(standardMaterial.bumpMap);
  const hasAlphaMap = 'alphaMap' in standardMaterial && Boolean(standardMaterial.alphaMap);
  const transmission =
    'transmission' in standardMaterial
      ? Number((standardMaterial as MeshStandardMaterial & { transmission?: number }).transmission ?? 0)
      : 0;
  const isTransparentLike =
    standardMaterial.transparent === true ||
    (standardMaterial.opacity ?? 1) < 0.999 ||
    transmission > 0.001;
  const shouldApplyDesignTextures =
    hasBaseColorMap && !isTransparentLike && !hasMetalnessMap && !hasRoughnessMap;

  // Preserve glass / transparent parts and only override channels that already exist.
  if (isTransparentLike) {
    material.needsUpdate = true;
    return material;
  }

  if (textures.color && shouldApplyDesignTextures) {
    standardMaterial.map = textures.color;

    if ('color' in standardMaterial) {
      standardMaterial.color?.set('#ffffff');
    }
  }

  if (textures.metalness && shouldApplyDesignTextures) {
    standardMaterial.metalnessMap = textures.metalness;
    standardMaterial.metalness = 1;
    standardMaterial.roughness = Math.min(standardMaterial.roughness ?? 0.42, 0.42);
  }

  if (textures.bump && (shouldApplyDesignTextures || hasBumpMap)) {
    standardMaterial.bumpMap = textures.bump;
    standardMaterial.bumpScale = 2;
  }

  if (textures.alpha && shouldApplyDesignTextures) {
    standardMaterial.alphaMap = textures.alpha;
    standardMaterial.transparent = true;
    standardMaterial.alphaTest = 0.05;
    standardMaterial.depthWrite = true;
  }

  if (shouldApplyDesignTextures && textureTransparencyEnabled && textures.color?.userData.hasAlpha === true) {
    standardMaterial.transparent = true;
    standardMaterial.alphaTest = Math.max(standardMaterial.alphaTest ?? 0, 0.05);
    standardMaterial.depthWrite = true;
  }

  material.needsUpdate = true;
  return material;
}

function snapshotMaterial(material: Material) {
  const standardMaterial = material as MeshStandardMaterial & {
    transmission?: number;
  };

  return {
    alphaMap: 'alphaMap' in standardMaterial ? standardMaterial.alphaMap ?? null : null,
    alphaTest: standardMaterial.alphaTest ?? 0,
    bumpMap: 'bumpMap' in standardMaterial ? standardMaterial.bumpMap ?? null : null,
    bumpScale: standardMaterial.bumpScale ?? 1,
    colorHex: 'color' in standardMaterial ? standardMaterial.color?.getHexString?.() ?? null : null,
    depthWrite: standardMaterial.depthWrite ?? true,
    map: 'map' in standardMaterial ? standardMaterial.map ?? null : null,
    metalness: standardMaterial.metalness ?? 0,
    metalnessMap: 'metalnessMap' in standardMaterial ? standardMaterial.metalnessMap ?? null : null,
    opacity: standardMaterial.opacity ?? 1,
    roughness: standardMaterial.roughness ?? 1,
    roughnessMap: 'roughnessMap' in standardMaterial ? standardMaterial.roughnessMap ?? null : null,
    transparent: standardMaterial.transparent ?? false,
    transmission: Number(standardMaterial.transmission ?? 0),
  } satisfies MaterialSnapshot;
}

function cloneSceneForDisplay(scene: Object3D, shadingPreset: ShadingPreset) {
  const shouldCloneForNormals = shadingPreset !== 'source';
  const nextScene = scene.clone(true);
  const creaseAngle = Number(shadingPreset) * (Math.PI / 180);

  nextScene.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) {
      return;
    }

    if (shouldCloneForNormals && mesh.geometry) {
      mesh.geometry = toCreasedNormals(mesh.geometry.clone(), creaseAngle);
      mesh.geometry.userData.codexOwnedGeometry = true;
    }

    if (mesh.material) {
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((material) => {
            const nextMaterial = material.clone();
            nextMaterial.userData.codexOwnedMaterial = true;
            nextMaterial.userData.codexOriginalMaterial = snapshotMaterial(nextMaterial);
            return nextMaterial;
          })
        : (() => {
            const nextMaterial = mesh.material.clone();
            nextMaterial.userData.codexOwnedMaterial = true;
            nextMaterial.userData.codexOriginalMaterial = snapshotMaterial(nextMaterial);
            return nextMaterial;
          })();
    }
  });

  return nextScene;
}

function applyTexturesToScene(scene: Object3D, textures: LoadedTextureSlots, textureTransparencyEnabled: boolean) {
  scene.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.material) {
      return;
    }

    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((material) => {
        applyTexturesToMaterial(material as Material & { userData: Record<string, unknown> }, textures, textureTransparencyEnabled);
      });
      return;
    }

    applyTexturesToMaterial(mesh.material as Material & { userData: Record<string, unknown> }, textures, textureTransparencyEnabled);
  });
}

function disposeDisplayScene(scene: Object3D) {
  scene.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) {
      return;
    }

    if (mesh.geometry?.userData.codexOwnedGeometry) {
      mesh.geometry.dispose();
    }

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => {
      if (material?.userData.codexOwnedMaterial) {
        material.dispose();
      }
    });
  });
}

function shouldInvertChannel(channel: TextureChannel) {
  return channel === 'metalness' || channel === 'bump';
}

function shouldBuildMaskTexture(channel: TextureChannel) {
  return channel === 'metalness' || channel === 'bump' || channel === 'alpha';
}

function useUploadedTexture(textureUrl: string | null, channel: TextureChannel, textureTransparencyEnabled: boolean) {
  const [texture, setTexture] = useState<Texture | null>(null);

  useEffect(() => {
    if (!textureUrl) {
      setTexture(null);
      return;
    }

    let cancelled = false;
    let loadedTexture: Texture | null = null;
    const image = new Image();

    image.onload = () => {
      // Fast path: color previews usually don't need per-pixel preprocessing.
      if (channel === 'color' && textureTransparencyEnabled) {
        const nextTexture = new Texture(image);
        nextTexture.colorSpace = SRGBColorSpace;
        nextTexture.flipY = false;
        nextTexture.userData.hasAlpha = true;
        nextTexture.needsUpdate = true;
        loadedTexture = nextTexture;

        if (cancelled) {
          nextTexture.dispose();
          return;
        }

        setTexture(nextTexture);
        return;
      }

      const textureCanvas = document.createElement('canvas');
      textureCanvas.width = image.naturalWidth;
      textureCanvas.height = image.naturalHeight;

      const textureContext = textureCanvas.getContext('2d', { willReadFrequently: shouldBuildMaskTexture(channel) });
      if (!textureContext) {
        const nextTexture = new Texture(image);
        nextTexture.colorSpace = channel === 'color' ? SRGBColorSpace : nextTexture.colorSpace;
        nextTexture.flipY = false;
        nextTexture.userData.hasAlpha = false;
        nextTexture.needsUpdate = true;
        loadedTexture = nextTexture;

        if (cancelled) {
          nextTexture.dispose();
          return;
        }

        setTexture(nextTexture);
        return;
      }

      let textureSource: HTMLCanvasElement | HTMLImageElement = image;
      let alphaEnabled = false;

      if (channel === 'color' && !textureTransparencyEnabled) {
        textureContext.fillStyle = '#ffffff';
        textureContext.fillRect(0, 0, textureCanvas.width, textureCanvas.height);
        textureContext.drawImage(image, 0, 0);
        textureSource = textureCanvas;
      } else if (shouldBuildMaskTexture(channel)) {
        textureContext.drawImage(image, 0, 0);
        const textureData = textureContext.getImageData(0, 0, textureCanvas.width, textureCanvas.height);

        for (let index = 0; index < textureData.data.length; index += 4) {
          const red = textureData.data[index];
          const green = textureData.data[index + 1];
          const blue = textureData.data[index + 2];
          const alpha = textureData.data[index + 3];
          const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
          const isTransparentPixel = alpha === 0;
          let maskValue = luminance;

          if (channel === 'metalness' || channel === 'bump') {
            maskValue = isTransparentPixel ? 0 : 255 - luminance;
          }

          if (channel === 'alpha') {
            maskValue = isTransparentPixel ? 255 : luminance;
          }

          textureData.data[index] = maskValue;
          textureData.data[index + 1] = maskValue;
          textureData.data[index + 2] = maskValue;
          textureData.data[index + 3] = 255;
        }

        textureContext.putImageData(textureData, 0, 0);
        textureSource = textureCanvas;
      }

      const nextTexture =
        textureSource instanceof HTMLCanvasElement ? new CanvasTexture(textureSource) : new Texture(textureSource);
      nextTexture.colorSpace = channel === 'color' ? SRGBColorSpace : nextTexture.colorSpace;
      nextTexture.flipY = false;
      nextTexture.userData.hasAlpha = alphaEnabled;
      nextTexture.needsUpdate = true;
      loadedTexture = nextTexture;

      if (cancelled) {
        nextTexture.dispose();
        return;
      }

      setTexture(nextTexture);
    };

    image.src = textureUrl;

    return () => {
      cancelled = true;
      if (loadedTexture) {
        loadedTexture.dispose();
      }
    };
  }, [channel, textureUrl, textureTransparencyEnabled]);

  return texture;
}

function UvWireframeOverlay({
  segments,
  color,
}: {
  segments: UvWireframeSegments;
  color: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) {
      return;
    }

    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    if (segments.length === 0) {
      return;
    }

    context.lineWidth = 1.4;
    context.strokeStyle = color;
    context.beginPath();

    for (let index = 0; index < segments.length; index += 4) {
      const startX = segments[index] * width;
      const startY = segments[index + 1] * height;
      const endX = segments[index + 2] * width;
      const endY = segments[index + 3] * height;
      context.moveTo(startX, startY);
      context.lineTo(endX, endY);
    }

    context.stroke();
  }, [color, segments]);

  return <canvas ref={canvasRef} className="uv-wireframe-overlay" aria-hidden="true" />;
}

function ModelAsset({
  model,
  selectedUvImagePath,
  textureSlots,
  textureTransparencyEnabled,
  shadingPreset,
  onReady,
  onUvSegmentsReady,
  uvWireframeEnabled,
}: {
  model: ModelEntry;
  selectedUvImagePath?: string;
  textureSlots: TextureSlots;
  textureTransparencyEnabled: boolean;
  shadingPreset: ShadingPreset;
  onReady?: (fileName: string) => void;
  onUvSegmentsReady?: (fileName: string, segments: UvWireframeSegments) => void;
  uvWireframeEnabled: boolean;
}) {
  const gltf = useGLTF(model.path);
  const colorTextureUrl = textureSlots.color.url ?? selectedUvImagePath ?? null;
  const colorTexture = useUploadedTexture(colorTextureUrl, 'color', textureTransparencyEnabled);
  const metalnessTexture = useUploadedTexture(textureSlots.metalness.url, 'metalness', false);
  const bumpTexture = useUploadedTexture(textureSlots.bump.url, 'bump', false);
  const alphaTexture = useUploadedTexture(textureSlots.alpha.url, 'alpha', false);
  const uploadedTextures = useMemo<LoadedTextureSlots>(
    () => ({
      alpha: alphaTexture,
      bump: bumpTexture,
      color: colorTexture,
      metalness: metalnessTexture,
    }),
    [alphaTexture, bumpTexture, colorTexture, metalnessTexture],
  );
  const scene = useMemo(() => cloneSceneForDisplay(gltf.scene, shadingPreset), [gltf.scene, shadingPreset]);

  useEffect(() => {
    return () => disposeDisplayScene(scene);
  }, [scene]);

  useEffect(() => {
    applyTexturesToScene(scene, uploadedTextures, textureTransparencyEnabled);
  }, [scene, textureTransparencyEnabled, uploadedTextures]);

  useEffect(() => {
    onReady?.(model.fileName);
  }, [model.fileName, onReady, scene]);

  useEffect(() => {
    if (!uvWireframeEnabled) {
      return;
    }

    const cachedSegments = uvWireframeSegmentsCache.get(model.path);
    if (cachedSegments) {
      onUvSegmentsReady?.(model.fileName, cachedSegments);
      return;
    }

    let cancelled = false;
    const idleHandle = scheduleIdleTask(() => {
      const segments = buildUvWireframeSegments(gltf.scene);
      uvWireframeSegmentsCache.set(model.path, segments);

      if (!cancelled) {
        onUvSegmentsReady?.(model.fileName, segments);
      }
    });

    return () => {
      cancelled = true;
      cancelIdleTask(idleHandle);
    };
  }, [gltf.scene, model.fileName, model.path, onUvSegmentsReady, uvWireframeEnabled]);

  return (
    <group name="active-model-root">
      <Center>
        <primitive object={scene} />
      </Center>
    </group>
  );
}

function CameraResetter({ activeModelId, resetToken }: { activeModelId: string; resetToken: number }) {
  const bounds = useBounds();

  useEffect(() => {
    bounds.refresh().clip().fit();
  }, [activeModelId, resetToken]);

  return null;
}

function Scene({
  activeModel,
  gridVisible,
  resetToken,
  controlsRef,
  selectedUvImagePath,
  textureSlots,
  textureTransparencyEnabled,
  shadingPreset,
  onModelReady,
  onModelError,
  onUvSegmentsReady,
  uvWireframeEnabled,
}: {
  activeModel: ModelEntry;
  gridVisible: boolean;
  resetToken: number;
  controlsRef: React.MutableRefObject<OrbitControlsImpl | null>;
  selectedUvImagePath?: string;
  textureSlots: TextureSlots;
  textureTransparencyEnabled: boolean;
  shadingPreset: ShadingPreset;
  onModelReady?: (fileName: string) => void;
  onModelError?: (fileName: string) => void;
  onUvSegmentsReady?: (fileName: string, segments: UvWireframeSegments) => void;
  uvWireframeEnabled: boolean;
}) {
  const { camera } = useThree();

  useEffect(() => {
    camera.position.set(4, 3, 5);
    camera.near = 0.05;
    camera.far = 80;
    camera.updateProjectionMatrix();
  }, [activeModel.id, camera]);

  return (
    <>
      <color attach="background" args={['#d8d5cc']} />
      <ambientLight intensity={0.35} />
      <directionalLight position={[5, 6, 4]} intensity={1.05} />
      <directionalLight position={[-4, 2, -3]} intensity={0.35} />
      <Environment preset="warehouse" environmentIntensity={0.45} />

      {gridVisible ? (
        <Grid
          args={[16, 16]}
          cellColor="#d8d3c9"
          cellSize={0.5}
          fadeDistance={16}
          fadeStrength={1.4}
          infiniteGrid
          position={[0, -0.01, 0]}
          sectionColor="#9d9488"
          sectionSize={2}
        />
      ) : null}

      <ModelErrorBoundary fileName={activeModel.fileName} onError={onModelError}>
        <Bounds clip margin={1.35}>
          <Suspense fallback={null}>
            <ModelAsset
              model={activeModel}
              selectedUvImagePath={selectedUvImagePath}
              textureSlots={textureSlots}
              textureTransparencyEnabled={textureTransparencyEnabled}
              shadingPreset={shadingPreset}
              onReady={onModelReady}
              onUvSegmentsReady={onUvSegmentsReady}
              uvWireframeEnabled={uvWireframeEnabled}
            />
            <CameraResetter activeModelId={activeModel.id} resetToken={resetToken} />
          </Suspense>
        </Bounds>
      </ModelErrorBoundary>

      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.08}
        makeDefault
        maxDistance={80}
        minDistance={0.1}
        mouseButtons={{
          LEFT: 0,
          MIDDLE: 1,
          RIGHT: 2,
        }}
      />
    </>
  );
}

function fitOrthographicCameraToView(
  camera: OrthographicCamera,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const paddedWidth = Math.max(width, 0.001) * 1.12;
  const paddedHeight = Math.max(height, 0.001) * 1.12;

  camera.left = -viewportWidth / 2;
  camera.right = viewportWidth / 2;
  camera.top = viewportHeight / 2;
  camera.bottom = -viewportHeight / 2;
  camera.zoom = Math.min(viewportWidth / paddedWidth, viewportHeight / paddedHeight);
}

function ViewPresetController({
  activeModel,
  viewPreset,
  viewPresetToken,
}: {
  activeModel: ModelEntry;
  viewPreset: ViewPreset | null;
  viewPresetToken: number;
}) {
  const { camera, controls, invalidate, scene, size } = useThree();

  useEffect(() => {
    const orbitControls = controls as OrbitControlsImpl | undefined;
    if (!orbitControls || !viewPreset) {
      return;
    }

    const modelRoot = scene.getObjectByName('active-model-root');
    const bounds = modelRoot ? new Box3().setFromObject(modelRoot) : new Box3();
    const target = new Vector3();
    const boxSize = new Vector3();

    if (bounds.isEmpty()) {
      target.set(0, 0, 0);
      boxSize.set(4, 4, 4);
    } else {
      bounds.getCenter(target);
      bounds.getSize(boxSize);
    }

    orbitControls.target.copy(target);

    const viewDimensions: Record<ViewPreset, { width: number; height: number }> = {
      front: { width: boxSize.x, height: boxSize.y },
      back: { width: boxSize.x, height: boxSize.y },
      left: { width: boxSize.y, height: boxSize.z },
      right: { width: boxSize.y, height: boxSize.z },
      top: { width: boxSize.x, height: boxSize.y },
      bottom: { width: boxSize.x, height: boxSize.y },
    };
    const { width, height } = viewDimensions[viewPreset];
    let distance = Math.max(boxSize.x, boxSize.y, boxSize.z, 1) * 2;

    if (camera instanceof OrthographicCamera) {
      fitOrthographicCameraToView(camera, width, height, size.width, size.height);
    }

    if (camera instanceof PerspectiveCamera) {
      const fov = camera.fov;
      const aspect = Math.max(size.width / Math.max(size.height, 1), 0.1);
      const verticalFov = (fov * Math.PI) / 180;
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
      const fitHeightDistance = Math.max(height, 1) / (2 * Math.tan(verticalFov / 2));
      const fitWidthDistance = Math.max(width, 1) / (2 * Math.tan(horizontalFov / 2));
      distance = Math.max(fitHeightDistance, fitWidthDistance) * 1.18;
    }

    const directions: Record<ViewPreset, [number, number, number]> = {
      front: [0, 0, distance],
      back: [0, 0, -distance],
      left: [-distance, 0, 0],
      right: [distance, 0, 0],
      top: [0, distance, 0],
      bottom: [0, -distance, 0],
    };
    const [x, y, z] = directions[viewPreset];

    camera.position.set(target.x + x, target.y + y, target.z + z);
    camera.up.set(0, 1, 0);

    if (viewPreset === 'top') {
      camera.up.set(0, 0, -1);
    }

    if (viewPreset === 'bottom') {
      camera.up.set(0, 0, 1);
    }

    camera.lookAt(target);
    camera.updateProjectionMatrix();
    orbitControls.update();
    orbitControls.saveState();
    invalidate();
  }, [camera, controls, invalidate, scene, size.height, size.width, viewPreset, viewPresetToken]);

  return null;
}

export function ModelViewer({ models }: ModelViewerProps) {
  const [activeId, setActiveId] = useState(() => getInitialModel(models));
  const [gridVisible, setGridVisible] = useState(true);
  const [resetToken, setResetToken] = useState(0);
  const [viewerSplit, setViewerSplit] = useState(64);
  const [textureSlots, setTextureSlots] = useState<TextureSlots>(emptyTextureSlots);
  const [activeTextureChannel, setActiveTextureChannel] = useState<TextureChannel>('color');
  const [textureTransparencyEnabled, setTextureTransparencyEnabled] = useState(true);
  const [shadingPreset, setShadingPreset] = useState<ShadingPreset>('45');
  const [viewPreset, setViewPreset] = useState<ViewPreset | null>(null);
  const [viewPresetToken, setViewPresetToken] = useState(0);
  const [dragActiveChannel, setDragActiveChannel] = useState<TextureChannel | null>(null);
  const [selectedUvPath, setSelectedUvPath] = useState<string | null>(null);
  const [canvasPhase, setCanvasPhase] = useState<ModelCanvasPhase>('loading');
  const [loadingStep, setLoadingStep] = useState<ModelLoadingStep>('model');
  const [uvWireframeVisible, setUvWireframeVisible] = useState(true);
  const [uvWireframeSegments, setUvWireframeSegments] = useState<UvWireframeSegments>([]);
  const [uvWireframeColor, setUvWireframeColor] = useState('#ffffff');
  const [modelSceneReady, setModelSceneReady] = useState(false);
  const [uvWireframeReady, setUvWireframeReady] = useState(false);
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const textureSlotsRef = useRef(textureSlots);
  const textureInputRefs = useRef<Record<TextureChannel, HTMLInputElement | null>>({
    alpha: null,
    bump: null,
    color: null,
    metalness: null,
  });
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  const activeModel = useMemo(
    () => models.find((model) => model.id === activeId) ?? models[0],
    [activeId, models],
  );
  const availableUvImages = activeModel?.uvImages ?? [];
  const selectedUvImage =
    availableUvImages.find((uvImage) => uvImage.path === selectedUvPath) ??
    availableUvImages.find((uvImage) => uvImage.path === activeModel?.uvImagePath) ??
    availableUvImages[0];

  useEffect(() => {
    setCanvasPhase('loading');
    setLoadingStep('model');
    setModelSceneReady(false);
    const cachedSegments = uvWireframeSegmentsCache.get(activeModel?.path ?? '') ?? [];
    setUvWireframeSegments(cachedSegments);
    setUvWireframeReady(!uvWireframeVisible || cachedSegments.length > 0);
  }, [activeModel?.id, activeModel?.path]);

  useEffect(() => {
    if (!uvWireframeVisible) {
      setUvWireframeReady(true);
      return;
    }

    const cachedSegments = uvWireframeSegmentsCache.get(activeModel?.path ?? '') ?? [];
    setUvWireframeSegments(cachedSegments);
    setUvWireframeReady(cachedSegments.length > 0);
    if (modelSceneReady && cachedSegments.length === 0) {
      setCanvasPhase('loading');
      setLoadingStep('uv');
    }
  }, [activeModel?.path, modelSceneReady, uvWireframeVisible]);

  useEffect(() => {
    if (canvasPhase === 'error') {
      return;
    }

    if (!modelSceneReady) {
      setCanvasPhase('loading');
      setLoadingStep('model');
      return;
    }

    if (uvWireframeVisible && !uvWireframeReady) {
      setCanvasPhase('loading');
      setLoadingStep('uv');
      return;
    }

    setCanvasPhase('ready');
  }, [canvasPhase, modelSceneReady, uvWireframeReady, uvWireframeVisible]);

  const [slowLoading, setSlowLoading] = useState(false);

  useEffect(() => {
    if (canvasPhase !== 'loading') {
      setSlowLoading(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setSlowLoading(true);
    }, 2400);

    return () => window.clearTimeout(timer);
  }, [canvasPhase]);

  useEffect(() => {
    const onHashChange = () => {
      const hashId = window.location.hash.replace('#', '');
      if (models.some((model) => model.id === hashId)) {
        setActiveId(hashId);
      }
    };

    window.addEventListener('hashchange', onHashChange);
    onHashChange();

    return () => window.removeEventListener('hashchange', onHashChange);
  }, [models]);

  useEffect(() => {
    textureSlotsRef.current = textureSlots;
  }, [textureSlots]);

  useEffect(() => {
    setSelectedUvPath(null);
  }, [activeModel?.id]);

  useEffect(() => {
    return () => {
      Object.values(textureSlotsRef.current).forEach((textureSlot) => {
        if (textureSlot.url) {
          URL.revokeObjectURL(textureSlot.url);
        }
      });
    };
  }, []);

  if (!activeModel) {
    return (
      <div className="viewer-empty">
        <TriangleAlert size={24} aria-hidden="true" />
        未配置模型。
      </div>
    );
  }

  const startSplitDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const workbench = workbenchRef.current;
    if (!workbench) {
      return;
    }

    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const updateSplit = (clientX: number) => {
      const rect = workbench.getBoundingClientRect();
      const nextSplit = ((clientX - rect.left) / rect.width) * 100;
      setViewerSplit(Math.min(82, Math.max(38, nextSplit)));
    };

    const onPointerMove = (moveEvent: globalThis.PointerEvent) => {
      updateSplit(moveEvent.clientX);
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    updateSplit(event.clientX);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  };

  const applyTextureFile = (channel: TextureChannel, file: File | undefined) => {
    if (!file) {
      return;
    }

    if (!file.type.startsWith('image/')) {
      return;
    }

    const nextTextureUrl = URL.createObjectURL(file);
    setTextureSlots((previousTextureSlots) => {
      const previousTextureUrl = previousTextureSlots[channel].url;
      if (previousTextureUrl) {
        URL.revokeObjectURL(previousTextureUrl);
      }
      return {
        ...previousTextureSlots,
        [channel]: {
          name: file.name,
          url: nextTextureUrl,
        },
      };
    });
    setActiveTextureChannel(channel);
    setResetToken((value) => value + 1);
  };

  const handleTextureUpload = (channel: TextureChannel, event: ChangeEvent<HTMLInputElement>) => {
    applyTextureFile(channel, event.target.files?.[0]);
    event.target.value = '';
  };

  const clearUploadedTexture = (channel: TextureChannel) => {
    setTextureSlots((previousTextureSlots) => {
      const previousTextureUrl = previousTextureSlots[channel].url;
      if (previousTextureUrl) {
        URL.revokeObjectURL(previousTextureUrl);
      }
      return {
        ...previousTextureSlots,
        [channel]: {
          name: null,
          url: null,
        },
      };
    });
  };

  const clearAllUploadedTextures = () => {
    setTextureSlots((previousTextureSlots) => {
      Object.values(previousTextureSlots).forEach((textureSlot) => {
        if (textureSlot.url) {
          URL.revokeObjectURL(textureSlot.url);
        }
      });

      return emptyTextureSlots;
    });
    setActiveTextureChannel('color');
    setDragActiveChannel(null);
  };

  const handleTextureDragOver = (channel: TextureChannel, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActiveChannel(channel);
  };

  const handleTextureDragLeave = (channel: TextureChannel, event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragActiveChannel((currentChannel) => (currentChannel === channel ? null : currentChannel));
    }
  };

  const handleTextureDrop = (channel: TextureChannel, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActiveChannel(null);
    applyTextureFile(channel, event.dataTransfer.files?.[0]);
  };

  const applyViewPreset = (nextViewPreset: ViewPreset) => {
    setViewPreset(nextViewPreset);
    setViewPresetToken((value) => value + 1);
  };

  const activeTextureSlot = textureSlots[activeTextureChannel];
  const uploadedTextureCount = Object.values(textureSlots).filter((textureSlot) => textureSlot.url).length;
  const showCanvasOverlay = canvasPhase !== 'ready';

  return (
    <div className="viewer-panel">
      <div className="viewer-toolbar" aria-label="Viewer controls">
        <div className="active-model-label">
          <Eye size={16} aria-hidden="true" />
          <span>{activeModel.name}</span>
          <small>{activeModel.fileName}</small>
        </div>

        <div className="viewer-actions">
          <div className="view-preset-group" aria-label="View presets">
            {viewPresetButtons.map((preset) => (
              <button
                className="view-preset-button"
                type="button"
                key={preset.value}
                aria-pressed={viewPreset === preset.value}
                onClick={() => applyViewPreset(preset.value)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <button
            className="text-toggle-button"
            title={textureTransparencyEnabled ? '关闭后透明部分会显示为白色' : '开启后使用贴图透明通道'}
            type="button"
            aria-pressed={textureTransparencyEnabled}
            onClick={() => setTextureTransparencyEnabled((enabled) => !enabled)}
          >
            开启贴图透明
          </button>
          <label className="viewer-select">
            <span>硬边角度</span>
            <select value={shadingPreset} onChange={(event) => setShadingPreset(event.currentTarget.value as ShadingPreset)}>
              {shadingPresetOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="icon-button"
            title={gridVisible ? '隐藏网格' : '显示网格'}
            type="button"
            aria-pressed={gridVisible}
            onClick={() => setGridVisible((visible) => !visible)}
          >
            <Grid3X3 size={17} aria-hidden="true" />
          </button>
          <button
            className="icon-button"
            title="重置视角"
            type="button"
            onClick={() => {
              controlsRef.current?.reset();
              setResetToken((value) => value + 1);
            }}
          >
            <RotateCcw size={17} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div
        className="workbench-grid"
        ref={workbenchRef}
        style={{ '--viewer-split': `${viewerSplit}%` } as React.CSSProperties}
      >
        <div className="canvas-wrap">
          {showCanvasOverlay ? (
            <div
              className={`canvas-overlay ${canvasPhase === 'error' ? 'canvas-overlay-error' : ''}`}
              role={canvasPhase === 'error' ? 'alert' : 'status'}
            >
              {canvasPhase === 'loading' ? (
                <>
                  <div className="canvas-overlay-icon">
                    <span className="canvas-spinner" aria-hidden="true" />
                  </div>
                  <div className="canvas-overlay-copy">
                    <strong>{loadingStep === 'model' ? '正在加载 3D 模型' : '正在生成 UV 线框'}</strong>
                    <span>{activeModel.fileName}</span>
                    <small>
                      {loadingStep === 'model'
                        ? slowLoading
                          ? '加载较慢时，通常是模型体积较大或局域网传输较慢。'
                          : '页面已打开，模型文件仍在单独加载。'
                        : slowLoading
                          ? 'UV 线框会遍历模型拓扑，大模型首次生成会更慢。'
                          : '模型已加载完成，正在计算 UV 线框。'}
                    </small>
                  </div>
                </>
              ) : (
                <>
                  <div className="canvas-overlay-icon">
                    <TriangleAlert size={22} aria-hidden="true" />
                  </div>
                  <div className="canvas-overlay-copy">
                    <strong>模型没有加载成功</strong>
                    <span>{activeModel.fileName}</span>
                    <small>请刷新页面重试，或先切换到示例模型确认当前电脑是否能正常显示 3D。</small>
                  </div>
                </>
              )}
            </div>
          ) : null}
          {isExampleModel(activeModel) ? (
            <div className="viewer-note-card" role="note">
              <strong>示例模型贴图 / UV</strong>
              <span>
                公盘：<em>Studio NAEO / 平面贴图到 3d-web / 示例</em>
              </span>
            </div>
          ) : null}
          <Canvas
            orthographic
            camera={{ position: [4, 3, 5], zoom: 90, near: 0.05, far: 80 }}
            gl={{ logarithmicDepthBuffer: true }}
            shadows
          >
            <Scene
              activeModel={activeModel}
              gridVisible={gridVisible}
              resetToken={resetToken}
              controlsRef={controlsRef}
              selectedUvImagePath={selectedUvImage?.path}
              textureSlots={textureSlots}
              textureTransparencyEnabled={textureTransparencyEnabled}
              shadingPreset={shadingPreset}
              uvWireframeEnabled={uvWireframeVisible}
              onModelReady={(fileName) => {
                if (fileName === activeModel.fileName) {
                  setModelSceneReady(true);
                }
              }}
              onModelError={(fileName) => {
                if (fileName === activeModel.fileName) {
                  setCanvasPhase('error');
                }
              }}
              onUvSegmentsReady={(fileName, segments) => {
                if (fileName === activeModel.fileName) {
                  setUvWireframeSegments(segments);
                  setUvWireframeReady(true);
                }
              }}
            />
            <ViewPresetController
              activeModel={activeModel}
              viewPreset={viewPreset}
              viewPresetToken={viewPresetToken}
            />
          </Canvas>
        </div>

        <button
          className="split-handle"
          type="button"
          aria-label="Resize 3D and UV panels"
          title="Drag to resize 3D and UV panels"
          onPointerDown={startSplitDrag}
        />

        <aside className="uv-panel" aria-label="UV reference image">
          <div className="uv-panel-header">
            <div>
              <span className="eyebrow">UV 参考</span>
              <h3>贴图布局</h3>
            </div>
          </div>

          <div className="texture-actions" aria-label="Texture channel uploads">
            {textureChannelOptions.map((channelOption) => {
              const textureSlot = textureSlots[channelOption.value];

              return (
                <div
                  className="texture-channel"
                  data-active={activeTextureChannel === channelOption.value ? 'true' : undefined}
                  data-drag-active={dragActiveChannel === channelOption.value ? 'true' : undefined}
                  key={channelOption.value}
                  onDragOver={(event) => handleTextureDragOver(channelOption.value, event)}
                  onDragLeave={(event) => handleTextureDragLeave(channelOption.value, event)}
                  onDrop={(event) => handleTextureDrop(channelOption.value, event)}
                >
                  <input
                    ref={(element) => {
                      textureInputRefs.current[channelOption.value] = element;
                    }}
                    className="texture-input"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => handleTextureUpload(channelOption.value, event)}
                  />
                  <button
                    className="texture-channel-main"
                    type="button"
                    aria-pressed={activeTextureChannel === channelOption.value}
                    onClick={() => setActiveTextureChannel(channelOption.value)}
                  >
                    <span>
                      <strong>{channelOption.label}</strong>
                      <small>{textureSlot.name ?? channelOption.helper}</small>
                    </span>
                  </button>
                  <button
                    className="texture-channel-upload"
                    title={`上传${channelOption.label}贴图`}
                    type="button"
                    onClick={() => {
                      setActiveTextureChannel(channelOption.value);
                      textureInputRefs.current[channelOption.value]?.click();
                    }}
                  >
                    <Upload size={14} aria-hidden="true" />
                  </button>
                  {textureSlot.url ? (
                    <button
                      className="texture-channel-clear"
                      title={`清除${channelOption.label}贴图`}
                      type="button"
                      onClick={() => clearUploadedTexture(channelOption.value)}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              );
            })}
            <button
              className="texture-clear-all"
              type="button"
              disabled={uploadedTextureCount === 0}
              onClick={clearAllUploadedTextures}
            >
              <X size={14} aria-hidden="true" />
              清空所有贴图
            </button>
          </div>

          {availableUvImages.length > 0 ? (
            <div className="uv-switcher">
              <div className="uv-switcher-group">
                <label htmlFor="uv-reference-select">UV 图</label>
                <select
                  id="uv-reference-select"
                  value={selectedUvImage?.path ?? ''}
                  onChange={(event) => setSelectedUvPath(event.currentTarget.value)}
                >
                  {availableUvImages.map((uvImage) => (
                    <option key={uvImage.path} value={uvImage.path}>
                      {uvImage.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="uv-wireframe-controls">
                <div className="uv-switcher-group">
                  <span className="uv-wireframe-label">UV 线框</span>
                  <button
                    className="uv-wireframe-toggle"
                    type="button"
                    aria-pressed={uvWireframeVisible}
                    onClick={() => setUvWireframeVisible((visible) => !visible)}
                  >
                    {uvWireframeVisible ? 'UV 开启' : 'UV 关闭'}
                  </button>
                </div>

                <label className="uv-color-picker" htmlFor="uv-wireframe-color-input">
                  <span>颜色</span>
                  <input
                    id="uv-wireframe-color-input"
                    type="color"
                    value={uvWireframeColor}
                    onChange={(event) => setUvWireframeColor(event.currentTarget.value)}
                  />
                </label>
              </div>
            </div>
          ) : null}

          {activeTextureSlot.url ? (
            <div className="uv-image-frame">
              <div className="uv-image-stage">
                <img src={activeTextureSlot.url} alt={`${activeTextureSlot.name ?? 'Uploaded'} texture preview`} />
                {uvWireframeVisible ? (
                  <UvWireframeOverlay segments={uvWireframeSegments} color={uvWireframeColor} />
                ) : null}
              </div>
            </div>
          ) : selectedUvImage ? (
            <div className="uv-image-frame">
              <div className="uv-image-stage">
                <img src={selectedUvImage.path} alt={`${selectedUvImage.name} UV layout`} />
                {uvWireframeVisible ? (
                  <UvWireframeOverlay segments={uvWireframeSegments} color={uvWireframeColor} />
                ) : null}
              </div>
            </div>
          ) : (
            <div className="uv-empty">
              <ImageIcon size={24} aria-hidden="true" />
              未关联 UV 图片。
            </div>
          )}

          <div className="uv-caption">
            <ImageIcon size={15} aria-hidden="true" />
            <span>
              {activeTextureSlot.name
                ? `${textureChannelOptions.find((option) => option.value === activeTextureChannel)?.label}: ${
                    activeTextureSlot.name
                  }`
                : selectedUvImage?.fileName ?? '没有 UV 文件'}
            </span>
          </div>
        </aside>
      </div>

      <div className="viewer-status">
        <span>左键拖动旋转</span>
        <span>滚轮缩放</span>
        <span>右键拖动平移</span>
        <span>{uploadedTextureCount} 张贴图</span>
      </div>
    </div>
  );
}
