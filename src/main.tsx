import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Box, Grid3X3, RotateCcw } from 'lucide-react';
import { ModelViewer } from './viewer/ModelViewer';
import { modelCatalog } from './modelCatalog';
import './styles.css';

function App() {
  const groupedModels = modelCatalog.reduce<Record<string, typeof modelCatalog>>((groups, model) => {
    groups[model.groupName] = groups[model.groupName] ?? [];
    groups[model.groupName].push(model);
    return groups;
  }, {});

  return (
    <main className="app-shell">
      <aside className="model-sidebar" aria-label="Model list">
        <div className="brand-block">
          <div className="brand-mark">
            <Box size={20} aria-hidden="true" />
          </div>
          <div>
            <h1>GLB Viewer</h1>
            <p>{modelCatalog.length} built-in slots</p>
          </div>
        </div>

        <nav className="model-list" aria-label="Available models">
          {Object.entries(groupedModels).map(([groupName, models]) => (
            <section className="model-group" key={groupName}>
              <h2>{groupName}</h2>
              <div className="model-group-items">
                {models.map((model, index) => (
                  <a
                    className="model-link"
                    href={`#${model.id}`}
                    key={model.id}
                    data-default={index === 0 ? 'true' : undefined}
                  >
                    <span className="model-thumb">
                      <Box size={18} aria-hidden="true" />
                    </span>
                    <span>
                      <strong>{model.name}</strong>
                      <small>{model.fileName}</small>
                    </span>
                  </a>
                ))}
              </div>
            </section>
          ))}
        </nav>

        <div className="sidebar-note">
          <Grid3X3 size={16} aria-hidden="true" />
          <span>Put GLB files in product folders under public/models. The list is generated automatically.</span>
        </div>
      </aside>

      <section className="viewer-shell" aria-label="3D model viewer">
        <div className="viewer-topbar">
          <div>
            <span className="eyebrow">Orbit / Pan / Zoom</span>
            <h2>查看 / 定位 UV 位置</h2>
          </div>
          <div className="control-hint">
            <RotateCcw size={15} aria-hidden="true" />
            <span>Use reset to frame the active model</span>
          </div>
        </div>
        <ModelViewer models={modelCatalog} />
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
