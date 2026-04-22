import { Canvas, useThree } from '@react-three/fiber';
import { Bounds, Center, Environment, Grid, Html, OrbitControls, useBounds, useGLTF } from '@react-three/drei';
import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, PointerEvent } from 'react';
import type { ReactNode } from 'react';
import { Eye, Grid3X3, ImageIcon, Loader2, RotateCcw, TriangleAlert, Upload, X } from 'lucide-react';
import {
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
  TextureLoader,
  Vector3,
} from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { ModelEntry } from '../modelCatalog';

type ModelViewerProps = {
  models: ModelEntry[];
};

type ViewPreset = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
type TextureChannel = 'color' | 'metalness' | 'bump' | 'alpha';

type TextureSlot = {
  name: string | null;
  url: string | null;
};

type TextureSlots = Record<TextureChannel, TextureSlot>;

type LoadedTextureSlots = Partial<Record<TextureChannel, Texture | null>>;

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

const emptyTextureSlots: TextureSlots = {
  color: { name: null, url: null },
  metalness: { name: null, url: null },
  bump: { name: null, url: null },
  alpha: { name: null, url: null },
};

class ModelErrorBoundary extends Component<
  { children: ReactNode; fileName: string },
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

function applyTexturesToMaterial(
  material: Material,
  textures: LoadedTextureSlots,
  textureTransparencyEnabled: boolean,
) {
  const nextMaterial = material.clone();
  const standardMaterial = nextMaterial as MeshStandardMaterial;
  const hasPbrMapTarget =
    'map' in standardMaterial ||
    'metalnessMap' in standardMaterial ||
    'bumpMap' in standardMaterial ||
    'alphaMap' in standardMaterial;

  if (!hasPbrMapTarget) {
    return nextMaterial;
  }

  if (textures.color && 'map' in standardMaterial) {
    standardMaterial.map = textures.color;

    if ('color' in standardMaterial) {
      standardMaterial.color?.set('#ffffff');
    }
  }

  if (textures.metalness && 'metalnessMap' in standardMaterial) {
    standardMaterial.metalnessMap = textures.metalness;
    standardMaterial.metalness = 1;
    standardMaterial.roughness = Math.min(standardMaterial.roughness ?? 0.42, 0.42);
  }

  if (textures.bump && 'bumpMap' in standardMaterial) {
    standardMaterial.bumpMap = textures.bump;
    standardMaterial.bumpScale = 2;
  }

  if (textures.alpha && 'alphaMap' in standardMaterial) {
    standardMaterial.alphaMap = textures.alpha;
    standardMaterial.transparent = true;
    standardMaterial.alphaTest = 0.05;
    standardMaterial.depthWrite = true;
  }

  if (textureTransparencyEnabled && textures.color?.userData.hasAlpha === true) {
    standardMaterial.transparent = true;
    standardMaterial.alphaTest = Math.max(standardMaterial.alphaTest ?? 0, 0.05);
    standardMaterial.depthWrite = true;
  }

  nextMaterial.needsUpdate = true;
  return nextMaterial;
}

function cloneSceneWithTextures(
  scene: Object3D,
  textures: LoadedTextureSlots,
  textureTransparencyEnabled: boolean,
) {
  if (!Object.values(textures).some(Boolean)) {
    return scene;
  }

  const nextScene = scene.clone(true);

  nextScene.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.material) {
      return;
    }

    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((material) => applyTexturesToMaterial(material, textures, textureTransparencyEnabled))
      : applyTexturesToMaterial(mesh.material, textures, textureTransparencyEnabled);
  });

  return nextScene;
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
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;

      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        const loader = new TextureLoader();
        loader.load(textureUrl, (nextTexture) => {
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
        });
        return;
      }

      context.drawImage(image, 0, 0);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      let hasAlpha = false;

      for (let index = 3; index < imageData.data.length; index += 4) {
        if (imageData.data[index] < 255) {
          hasAlpha = true;
          break;
        }
      }

      let textureSource: HTMLCanvasElement | HTMLImageElement = image;
      let alphaEnabled = false;

      if (hasAlpha || shouldBuildMaskTexture(channel)) {
        const textureCanvas = document.createElement('canvas');
        textureCanvas.width = image.naturalWidth;
        textureCanvas.height = image.naturalHeight;

        const textureContext = textureCanvas.getContext('2d');
        if (textureContext) {
          if (hasAlpha && channel === 'color' && !textureTransparencyEnabled) {
            textureContext.fillStyle = '#ffffff';
            textureContext.fillRect(0, 0, textureCanvas.width, textureCanvas.height);
          }
          textureContext.drawImage(image, 0, 0);

          if (shouldBuildMaskTexture(channel)) {
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
          }

          textureSource = textureCanvas;
          alphaEnabled = channel === 'color' && hasAlpha && textureTransparencyEnabled;
        }
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

function ModelAsset({
  model,
  selectedUvImagePath,
  textureSlots,
  textureTransparencyEnabled,
}: {
  model: ModelEntry;
  selectedUvImagePath?: string;
  textureSlots: TextureSlots;
  textureTransparencyEnabled: boolean;
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
  const scene = useMemo(
    () => cloneSceneWithTextures(gltf.scene, uploadedTextures, textureTransparencyEnabled),
    [gltf.scene, textureTransparencyEnabled, uploadedTextures],
  );

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
}: {
  activeModel: ModelEntry;
  gridVisible: boolean;
  resetToken: number;
  controlsRef: React.MutableRefObject<OrbitControlsImpl | null>;
  selectedUvImagePath?: string;
  textureSlots: TextureSlots;
  textureTransparencyEnabled: boolean;
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

      <ModelErrorBoundary fileName={activeModel.fileName}>
        <Bounds clip margin={1.35}>
          <Suspense
            fallback={
              <Html center className="canvas-message">
                <Loader2 className="spin" size={22} aria-hidden="true" />
                Loading model
              </Html>
          }
        >
            <ModelAsset
              model={activeModel}
              selectedUvImagePath={selectedUvImagePath}
              textureSlots={textureSlots}
              textureTransparencyEnabled={textureTransparencyEnabled}
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
  const [viewPreset, setViewPreset] = useState<ViewPreset | null>(null);
  const [viewPresetToken, setViewPresetToken] = useState(0);
  const [dragActiveChannel, setDragActiveChannel] = useState<TextureChannel | null>(null);
  const [selectedUvPath, setSelectedUvPath] = useState<string | null>(null);
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
        No models configured.
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
          <button
            className="icon-button"
            title={gridVisible ? 'Hide grid' : 'Show grid'}
            type="button"
            aria-pressed={gridVisible}
            onClick={() => setGridVisible((visible) => !visible)}
          >
            <Grid3X3 size={17} aria-hidden="true" />
          </button>
          <button
            className="icon-button"
            title="Reset view"
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
              <span className="eyebrow">UV Reference</span>
              <h3>Texture layout</h3>
            </div>
            {selectedUvImage ? (
              <a className="uv-open-link" href={selectedUvImage.path} target="_blank" rel="noreferrer">
                UV
              </a>
            ) : null}
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
          ) : null}

          {activeTextureSlot.url ? (
            <div className="uv-image-frame">
              <img src={activeTextureSlot.url} alt={`${activeTextureSlot.name ?? 'Uploaded'} texture preview`} />
            </div>
          ) : selectedUvImage ? (
            <div className="uv-image-frame">
              <img src={selectedUvImage.path} alt={`${selectedUvImage.name} UV layout`} />
            </div>
          ) : (
            <div className="uv-empty">
              <ImageIcon size={24} aria-hidden="true" />
              No UV image linked.
            </div>
          )}

          <div className="uv-caption">
            <ImageIcon size={15} aria-hidden="true" />
            <span>
              {activeTextureSlot.name
                ? `${textureChannelOptions.find((option) => option.value === activeTextureChannel)?.label}: ${
                    activeTextureSlot.name
                  }`
                : selectedUvImage?.fileName ?? 'No UV file'}
            </span>
          </div>
        </aside>
      </div>

      <div className="viewer-status">
        <span>Left drag rotate</span>
        <span>Wheel zoom</span>
        <span>Right drag pan</span>
        <span>{uploadedTextureCount} texture maps</span>
      </div>
    </div>
  );
}
