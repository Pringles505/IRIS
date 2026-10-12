import { v4 as uuid } from 'uuid';

const PROJECTS_KEY  = 'echovis_projects';
const PROJECT_DATA  = (id) => `echovis_project_${id}`;
const LAST_OPEN_KEY = 'echovis_last_open';

export function listProjects() {
  try { return JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? '[]'); }
  catch { return []; }
}

export function readProject(id) {
  try { return JSON.parse(localStorage.getItem(PROJECT_DATA(id))); }
  catch { return null; }
}

// Returns the saved project, or null when localStorage rejects the write
// (typically QuotaExceededError on very large documents). Callers that care
// about data loss (autosave) should surface the failure to the user.
export function writeProject(project) {
  const updatedAt = new Date().toISOString();
  const full = { ...project, updatedAt };
  const list = listProjects();
  const idx = list.findIndex(p => p.id === full.id);
  const meta = {
    id: full.id,
    name: full.name,
    createdAt: full.createdAt,
    updatedAt,
    nodeCount: full.nodes.length,
    linkCount: full.links.length,
    // Saves that don't capture a fresh thumbnail must not wipe the existing one.
    preview: full.preview !== undefined ? full.preview : (idx >= 0 ? list[idx].preview ?? null : null),
  };
  if (idx >= 0) list[idx] = meta;
  else list.unshift(meta);
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
    localStorage.setItem(PROJECT_DATA(full.id), JSON.stringify(full));
  } catch (err) {
    console.error('[projectStore] save failed (storage quota?):', err);
    return null;
  }
  return full;
}

export function duplicateProject(id) {
  const source = readProject(id);
  if (!source) return null;
  const copy = {
    ...source,
    id: uuid(),
    name: `${source.name} (copy)`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return writeProject(copy);
}

export function deleteProject(id) {
  const list = listProjects().filter(p => p.id !== id);
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
  localStorage.removeItem(PROJECT_DATA(id));
}

export function createBlankProject(name = 'Untitled') {
  return {
    version: 1,
    id: uuid(),
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [],
    links: [],
    slideBreaks: [],
  };
}

export function setLastOpen(id) {
  if (id) localStorage.setItem(LAST_OPEN_KEY, id);
  else localStorage.removeItem(LAST_OPEN_KEY);
}

export function getLastOpen() {
  return localStorage.getItem(LAST_OPEN_KEY);
}

export function downloadProjectFile(project) {
  const json = JSON.stringify(project, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.name.replace(/[^a-z0-9_\-]/gi, '_')}.echoproj`;
  a.click();
  URL.revokeObjectURL(url);
}

export function parseProjectFile(jsonString) {
  const data = JSON.parse(jsonString);
  if (!Array.isArray(data.nodes) || !Array.isArray(data.links)) {
    throw new Error('Invalid project file — missing nodes or links.');
  }
  return {
    version: data.version ?? 1,
    id: data.id ?? uuid(),
    name: data.name ?? 'Imported Project',
    createdAt: data.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: data.nodes,
    links: data.links,
    slideBreaks: Array.isArray(data.slideBreaks) ? data.slideBreaks : (Array.isArray(data.slides) ? data.slides : []),
    captureFrame: data.captureFrame ?? null,
  };
}

// Bundled read-only examples from <root>/ExampleProjects. Empty when the folder is absent.
const EXAMPLE_FILES = import.meta.glob('/ExampleProjects/*.echoproj', {
  query: '?raw', import: 'default', eager: true,
});

export function listExampleProjects() {
  return Object.entries(EXAMPLE_FILES)
    .map(([path, raw]) => {
      try {
        const data = JSON.parse(raw);
        const fileName = path.split('/').pop().replace(/\.echoproj$/, '');
        return {
          path,
          name: data.name ?? fileName,
          nodeCount: Array.isArray(data.nodes) ? data.nodes.length : 0,
          linkCount: Array.isArray(data.links) ? data.links.length : 0,
          preview: data.preview ?? null,
        };
      } catch (err) {
        console.error(`[projectStore] invalid example project ${path}:`, err);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Opens an example as a fresh local copy so edits never touch the bundled file
// and repeated opens don't overwrite each other.
export function instantiateExampleProject(path) {
  const raw = EXAMPLE_FILES[path];
  if (!raw) return null;
  const project = parseProjectFile(raw);
  const now = new Date().toISOString();
  return { ...project, id: uuid(), createdAt: now, updatedAt: now };
}

export function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
