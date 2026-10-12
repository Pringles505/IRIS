import React, { useState, useRef } from 'react';
import {
  listProjects, readProject, deleteProject,
  createBlankProject, writeProject,
  downloadProjectFile, parseProjectFile, formatDate,
  duplicateProject, listExampleProjects, instantiateExampleProject,
} from '../projects/projectStore';

const EXAMPLE_PROJECTS = listExampleProjects();

export default function ProjectsPage({ onOpen }) {
  const [projects, setProjects]     = useState(() => listProjects());
  const [renamingId, setRenamingId] = useState(null);
  const [renameVal, setRenameVal]   = useState('');
  const [error, setError]           = useState(null);
  const fileInputRef = useRef(null);

  const refresh = () => setProjects(listProjects());

  const handleNew = () => {
    const project = createBlankProject('Untitled');
    writeProject(project);
    onOpen(project);
  };

  const handleOpen = (meta) => {
    const project = readProject(meta.id);
    if (project) onOpen(project);
  };

  const handleOpenExample = (example) => {
    try {
      const project = instantiateExampleProject(example.path);
      if (!project) return;
      writeProject(project);
      onOpen(project);
    } catch (err) {
      setError(err.message);
      setTimeout(() => setError(null), 4000);
    }
  };

  const handleDelete = (e, meta) => {
    e.stopPropagation();
    if (!window.confirm(`Delete "${meta.name}"? This can't be undone.`)) return;
    deleteProject(meta.id);
    refresh();
  };

  const handleDownload = (e, meta) => {
    e.stopPropagation();
    const project = readProject(meta.id);
    if (project) downloadProjectFile(project);
  };

  const handleDuplicate = (e, id) => {
    e.stopPropagation();
    duplicateProject(id);
    refresh();
  };

  const startRename = (e, meta) => {
    e.stopPropagation();
    setRenamingId(meta.id);
    setRenameVal(meta.name);
  };

  const commitRename = (id) => {
    const name = renameVal.trim() || 'Untitled';
    const project = readProject(id);
    if (project) writeProject({ ...project, name });
    setRenamingId(null);
    refresh();
  };

  const handleImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const project = parseProjectFile(ev.target.result);
        writeProject(project);
        onOpen(project);
      } catch (err) {
        setError(err.message);
        setTimeout(() => setError(null), 4000);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div style={{
      width: '100%',
      height: '100%',
      background: 'var(--app-bg)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      overflowY: 'auto',
    }}>
      <div style={{
        width: '100%',
        borderBottom: '1px solid var(--border-strong)',
        background: 'var(--panel-bg-2)',
        display: 'flex',
        alignItems: 'center',
        padding: 0,
        height: 52,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', height: '100%' }}>
          <img src="/IrisLogo.svg" alt="IRIS" style={{ width: 38, height: 38 }} />
          <span style={{ fontFamily: 'Lalezar, sans-serif', fontSize: 28, color: 'var(--text-main)', letterSpacing: '0.04em', lineHeight: 1 }}>IRIS</span>
        </div>
      </div>

      <div style={{ width: '100%', maxWidth: 860, padding: '48px 32px 64px', display: 'flex', flexDirection: 'column', gap: 32 }}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-main)', letterSpacing: '-0.01em' }}>
            Projects
          </h1>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => fileInputRef.current?.click()} style={btnStyle('ghost')}>
              Open file
            </button>
            <button onClick={handleNew} style={btnStyle('primary')}>
              + New project
            </button>
          </div>
        </div>

        {error && (
          <div style={{
            background: 'var(--danger-surface-soft)',
            border: '1px solid var(--danger-border-soft)',
            borderRadius: 8,
            padding: '10px 14px',
            color: 'var(--danger-bright)',
            fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {projects.length === 0 ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            padding: '80px 0',
            color: 'var(--text-dim)',
          }}>
            <div style={{ fontSize: 38, opacity: 0.3 }}>◈</div>
            <p style={{ fontSize: 14 }}>No projects yet — create one to get started.</p>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 14,
          }}>
            {projects.map(meta => (
              <ProjectCard
                key={meta.id}
                meta={meta}
                isRenaming={renamingId === meta.id}
                renameVal={renameVal}
                onOpen={() => handleOpen(meta)}
                onDelete={(e) => handleDelete(e, meta)}
                onDownload={(e) => handleDownload(e, meta)}
                onDuplicate={(e) => handleDuplicate(e, meta.id)}
                onStartRename={(e) => startRename(e, meta)}
                onRenameChange={setRenameVal}
                onRenameCommit={() => commitRename(meta.id)}
              />
            ))}
          </div>
        )}

        {EXAMPLE_PROJECTS.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-main)', letterSpacing: '-0.01em' }}>
              Example Projects
            </h2>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 14,
            }}>
              {EXAMPLE_PROJECTS.map(example => (
                <ExampleCard
                  key={example.path}
                  example={example}
                  onOpen={() => handleOpenExample(example)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".echoproj,.json"
        style={{ display: 'none' }}
        onChange={handleImport}
      />
    </div>
  );
}

function ProjectCard({
  meta, isRenaming, renameVal,
  onOpen, onDelete, onDownload, onDuplicate, onStartRename, onRenameChange, onRenameCommit,
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? 'var(--panel-bg-3)' : 'var(--panel-bg-2)',
        border: `1px solid ${hovered ? 'var(--purple-border-soft)' : 'var(--border-strong)'}`,
        borderRadius: 10,
        padding: '18px 18px 14px',
        cursor: 'pointer',
        transition: 'background 0.12s, border-color 0.12s',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        position: 'relative',
      }}
    >
      {hovered && (
        <div
          style={{ position: 'absolute', top: 10, right: 10, display: 'flex', gap: 6 }}
          onClick={e => e.stopPropagation()}
        >
          <IconBtn title="Rename" onClick={onStartRename}>✎</IconBtn>
          <IconBtn title="Duplicate" onClick={onDuplicate}>⧉</IconBtn>
          <IconBtn title="Download" onClick={onDownload}>↓</IconBtn>
          <IconBtn title="Delete" onClick={onDelete} danger>✕</IconBtn>
        </div>
      )}

      <div style={{
        height: 90,
        borderRadius: 6,
        background: 'var(--app-bg)',
        border: '1px solid var(--border-soft)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}>
        {meta.preview ? (
          <img
            src={meta.preview}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : meta.nodeCount > 0 ? (
          <MiniPreview nodeCount={meta.nodeCount} linkCount={meta.linkCount} />
        ) : (
          <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>Empty</span>
        )}
      </div>

      {isRenaming ? (
        <input
          autoFocus
          value={renameVal}
          onChange={e => onRenameChange(e.target.value)}
          onBlur={onRenameCommit}
          onKeyDown={e => { if (e.key === 'Enter') onRenameCommit(); if (e.key === 'Escape') onRenameCommit(); }}
          onClick={e => e.stopPropagation()}
          style={{
            background: 'var(--panel-bg-3)',
            border: '1px solid var(--purple-border-soft)',
            borderRadius: 4,
            color: 'var(--text-main)',
            fontSize: 13,
            fontWeight: 600,
            padding: '3px 6px',
            width: '100%',
          }}
        />
      ) : (
        <span style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-main)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {meta.name}
        </span>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          {formatDate(meta.updatedAt)}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          {meta.nodeCount} node{meta.nodeCount !== 1 ? 's' : ''} · {meta.linkCount} link{meta.linkCount !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}

function ExampleCard({ example, onOpen }) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title="Opens a copy of this example"
      style={{
        background: hovered ? 'var(--panel-bg-3)' : 'var(--panel-bg-2)',
        border: `1px solid ${hovered ? 'var(--purple-border-soft)' : 'var(--border-strong)'}`,
        borderRadius: 10,
        padding: '18px 18px 14px',
        cursor: 'pointer',
        transition: 'background 0.12s, border-color 0.12s',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{
        height: 90,
        borderRadius: 6,
        background: 'var(--app-bg)',
        border: '1px solid var(--border-soft)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}>
        {example.preview ? (
          <img
            src={example.preview}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : example.nodeCount > 0 ? (
          <MiniPreview nodeCount={example.nodeCount} linkCount={example.linkCount} />
        ) : (
          <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>Empty</span>
        )}
      </div>

      <span style={{
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--text-main)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {example.name}
      </span>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Example</span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          {example.nodeCount} node{example.nodeCount !== 1 ? 's' : ''} · {example.linkCount} link{example.linkCount !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}

function MiniPreview({ nodeCount, linkCount }) {
  const dots = Math.min(nodeCount, 6);
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center', padding: 12 }}>
      {Array.from({ length: dots }).map((_, i) => (
        <div key={i} style={{
          width: 28,
          height: 16,
          borderRadius: 4,
          background: 'var(--panel-blue)',
          border: '1px solid var(--border-strong)',
          opacity: 0.7 + (i % 3) * 0.1,
        }} />
      ))}
      {nodeCount > 6 && (
        <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>+{nodeCount - 6}</span>
      )}
    </div>
  );
}

function IconBtn({ children, onClick, title, danger = false }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: 24,
        height: 24,
        borderRadius: 5,
        border: `1px solid ${danger
          ? (hov ? 'var(--danger-border-soft)' : 'transparent')
          : (hov ? 'var(--border-strong)' : 'transparent')}`,
        background: danger
          ? (hov ? 'var(--danger-surface-soft)' : 'transparent')
          : (hov ? 'var(--panel-bg)' : 'transparent'),
        color: danger ? 'var(--danger-bright)' : 'var(--text-dim)',
        fontSize: 12,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background 0.1s, border-color 0.1s',
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

function btnStyle(variant) {
  const base = {
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    padding: '8px 16px',
    cursor: 'pointer',
    border: 'none',
    letterSpacing: '0.01em',
    whiteSpace: 'nowrap',
  };
  if (variant === 'primary') return { ...base, background: 'var(--purple-main)', color: 'var(--white)' };
  return { ...base, background: 'var(--panel-bg-3)', color: 'var(--text-muted)', border: '1px solid var(--border-strong)' };
}
