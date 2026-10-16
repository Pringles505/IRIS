import React, { useEffect, useRef, useState } from 'react';
import TopBar          from './components/TopBar';
import DiagramCanvas   from './components/canvas/DiagramCanvas';
import PropertiesPanel from './components/PropertiesPanel';
import ContextMenu     from './components/ContextMenu';
import KeyframePanel   from './components/KeyframePanel';
import ProjectsPage    from './components/ProjectsPage';
import DocsPage        from './components/DocsPage';
import { usePlayback } from './hooks/usePlayback';
import useStore        from './store/useStore';
import {
  getLastOpen, setLastOpen, readProject,
  writeProject, createBlankProject,
} from './projects/projectStore';
import { capturePreview } from './projects/capturePreview';
import { docsNav } from './docsNav';
import { useTriggeredKeyframeSync } from './events/useTriggeredKeyframeSync';

const AUTOSAVE_DELAY = 1500;

function App() {
  const [page, setPage]               = useState('loading');
  const [docsAnchor, setDocsAnchor]   = useState('');
  const [previewMode, setPreviewMode] = useState(false);
  const [previewBarVisible, setPreviewBarVisible] = useState(false);
  const hideBarTimer = useRef(null);

  useEffect(() => {
    docsNav.register((anchor) => {
      setDocsAnchor(anchor ?? '');
      setPage('docs');
    });
  }, []);

  const {
    nodes, links, slideBreaks, captureFrame, timelineEnd,
    activeProject, setActiveProject,
    loadProjectData,
  } = useStore();

  const stageRef      = useRef(null);
  const layerRef      = useRef(null);
  const saveTimer     = useRef(null);
  const activeRef     = useRef(activeProject);

  useEffect(() => { activeRef.current = activeProject; }, [activeProject]);

  useEffect(() => {
    const lastId = getLastOpen();
    if (lastId) {
      const project = readProject(lastId);
      if (project) {
        setActiveProject({ id: project.id, name: project.name, createdAt: project.createdAt });
        loadProjectData({ nodes: project.nodes, links: project.links, slideBreaks: project.slideBreaks ?? project.slides ?? [], captureFrame: project.captureFrame ?? null, timelineEnd: project.timelineEnd ?? null });
        setPage('editor');
        return;
      }
    }
    setPage('projects');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Warn once per session if autosave starts failing (storage quota), so edits
  // aren't silently lost.
  const saveFailureWarnedRef = useRef(false);
  const reportSaveResult = (saved) => {
    if (saved || saveFailureWarnedRef.current) return;
    saveFailureWarnedRef.current = true;
    alert('Autosave failed — browser storage is full. Use "Save file" in the top bar to keep a copy of your work.');
  };

  useEffect(() => {
    if (page !== 'editor') return;
    const ap = activeRef.current;
    if (!ap) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      reportSaveResult(writeProject({ version: 1, ...ap, nodes, links, slideBreaks, captureFrame, timelineEnd }));
    }, AUTOSAVE_DELAY);
    return () => clearTimeout(saveTimer.current);
  }, [nodes, links, page, slideBreaks, captureFrame, timelineEnd]);

  useEffect(() => {
    if (!previewMode) { setPreviewBarVisible(false); return; }
    const onMove = (e) => {
      if (e.clientY < 64) {
        setPreviewBarVisible(true);
        clearTimeout(hideBarTimer.current);
        hideBarTimer.current = setTimeout(() => setPreviewBarVisible(false), 2400);
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => { window.removeEventListener('mousemove', onMove); clearTimeout(hideBarTimer.current); };
  }, [previewMode]);

  const playback = usePlayback({ layerRef });
  useTriggeredKeyframeSync();
  const { isPlaying, play, pause } = playback;

  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Tab switches the editor mode (live animation ↔ blueprint).
        if (!stageRef.current) return; // only in the editor
        e.preventDefault();
        useStore.getState().cycleEditorMode();
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        if (isPlaying) pause(); else play();
      }
      if (e.code === 'KeyB' && (e.ctrlKey || e.metaKey)) {
        // Ghost alignment clipboard: copy the current selection (cross-tab), or — with
        // nothing selected — paste a ghost of the last copied selection at the viewport
        // centre. The ghost is overlay-only; it is never added to the document.
        const stage = stageRef.current;
        if (!stage) return; // only meaningful in the editor
        e.preventDefault();
        const st = useStore.getState();
        const hasSelection = !!st.selectedId || (st.selectedIds && st.selectedIds.length > 0);
        if (hasSelection) {
          st.copyGhostSelection();
        } else {
          const sx = stage.scaleX() || 1;
          const sy = stage.scaleY() || 1;
          const target = {
            x: (stage.width() / 2 - stage.x()) / sx,
            y: (stage.height() / 2 - stage.y()) / sy,
          };
          st.pasteGhostFromClipboard(target);
        }
        return;
      }
      if (e.code === 'KeyF' && (e.ctrlKey || e.metaKey)) {
        // Center capture frame to stage
        const { captureFrame } = useStore.getState();
        if (captureFrame) {
          const stage = stageRef.current;
          if (stage) {
            const dims = { w: stage.width(), h: stage.height() };
            const x = Math.round((dims.w - captureFrame.width) / 2);
            const y = Math.round((dims.h - captureFrame.height) / 2);
            useStore.getState().setCaptureFrame({ x, y });
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isPlaying, pause, play, stageRef]);

  const handleOpen = (project) => {
    setActiveProject({ id: project.id, name: project.name, createdAt: project.createdAt });
    loadProjectData({ nodes: project.nodes, links: project.links, slideBreaks: project.slideBreaks ?? project.slides ?? [], captureFrame: project.captureFrame ?? null, timelineEnd: project.timelineEnd ?? null });
    setLastOpen(project.id);
    setPage('editor');
  };

  const handleGoHome = () => {
    const ap = activeRef.current;
    if (ap) {
      clearTimeout(saveTimer.current);
      // Snapshot a thumbnail for the projects page; null leaves any previous one intact.
      let preview;
      try { preview = capturePreview(stageRef, layerRef, nodes, links) ?? undefined; }
      catch (err) { console.error('[App] preview capture failed:', err); }
      reportSaveResult(writeProject({ version: 1, ...ap, nodes, links, slideBreaks, captureFrame, timelineEnd, preview }));
    }
    setLastOpen(null);
    setPage('projects');
  };

  if (page === 'loading') return null;

  if (page === 'docs') {
    return <DocsPage anchor={docsAnchor} onBack={() => setPage(previewMode ? 'editor' : 'editor')} />;
  }

  if (page === 'projects') {
    return (
      <div style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
        <ProjectsPage onOpen={handleOpen} />
      </div>
    );
  }

  if (previewMode) {
    return (
      <div style={{
        width: '100vw', height: '100vh', overflow: 'hidden',
        background: '#04081A',
        position: 'relative',
        display: 'flex', alignItems: 'stretch',
      }}>
        {/* Canvas inset with visible margin */}
        <div style={{ position: 'absolute', inset: 48, display: 'flex' }}>
          <DiagramCanvas stageRef={stageRef} layerRef={layerRef} playback={playback} />
        </div>

        {/* Margin indicators — corners */}
        <PreviewIndicator side="bottom-left" />
        <PreviewIndicator side="bottom-right" />

        {/* Top hint — hover cue */}
        <div style={{
          position: 'absolute',
          top: 14,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          opacity: previewBarVisible ? 0 : 0.28,
          transition: 'opacity 0.3s',
          pointerEvents: 'none',
        }}>
          <span style={{ fontSize: 9, letterSpacing: '0.18em', color: '#60A5FA', textTransform: 'uppercase', fontWeight: 700 }}>
            ▲ controls
          </span>
        </div>

        {/* Invisible hover-trigger zone at top */}
        <div
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 56, zIndex: 9990 }}
          onMouseMove={() => {
            setPreviewBarVisible(true);
            clearTimeout(hideBarTimer.current);
            hideBarTimer.current = setTimeout(() => setPreviewBarVisible(false), 2400);
          }}
        />

        {/* Slide-down TopBar */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 9999,
          transform: previewBarVisible ? 'translateY(0)' : 'translateY(-100%)',
          transition: 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
          willChange: 'transform',
          boxShadow: previewBarVisible ? '0 4px 32px rgba(0,0,0,0.6)' : 'none',
        }}>
          <TopBar
            stageRef={stageRef}
            layerRef={layerRef}
            onGoHome={handleGoHome}
            onTogglePreview={() => setPreviewMode(false)}
          />
        </div>

        <ContextMenu />
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      overflow: 'hidden',
      background: 'var(--app-bg)',
    }}>
      <TopBar
        stageRef={stageRef}
        layerRef={layerRef}
        onGoHome={handleGoHome}
        onTogglePreview={() => setPreviewMode(true)}
      />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <DiagramCanvas stageRef={stageRef} layerRef={layerRef} playback={playback} />
        <PropertiesPanel />
      </div>

      <KeyframePanel playback={playback} />

      <ContextMenu />
    </div>
  );
}

function PreviewIndicator({ side }) {
  const isBottom = side.startsWith('bottom');
  const isLeft   = side.endsWith('left');
  return (
    <div style={{
      position: 'absolute',
      bottom: isBottom ? 14 : undefined,
      top:    !isBottom ? 14 : undefined,
      left:   isLeft ? 14 : undefined,
      right:  !isLeft ? 14 : undefined,
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      opacity: 0.22,
      pointerEvents: 'none',
      userSelect: 'none',
    }}>
      <div style={{
        width: 5,
        height: 5,
        borderRadius: '50%',
        background: '#60A5FA',
        boxShadow: '0 0 6px #a78bfa',
        flexShrink: 0,
      }} />
      {isLeft && (
        <span style={{
          fontSize: 8,
          letterSpacing: '0.2em',
          color: '#60A5FA',
          fontWeight: 700,
          textTransform: 'uppercase',
        }}>
          IRIS Preview
        </span>
      )}
    </div>
  );
}

export default App;
