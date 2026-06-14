import React, { useState, useRef, useEffect, useCallback } from 'react';
import useStore from '../store/useStore';
import { exportGifPackageZip } from '../export/GifPackageExporter';
import { writeProject, downloadProjectFile, parseProjectFile } from '../projects/projectStore';

// ── Utilities ─────────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const m = /^#?([a-f0-9]{6})$/i.exec(String(hex || '').trim());
  if (!m) return { r: 255, g: 0, b: 255 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function findPlaceholderRect(data, width, height, hex, tol = 48) {
  const { r: tr, g: tg, b: tb } = hexToRgb(hex);
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 16) continue;
      if (Math.abs(data[i] - tr) <= tol && Math.abs(data[i + 1] - tg) <= tol && Math.abs(data[i + 2] - tb) <= tol) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const parseSlideList = (text) => [...new Set(
  String(text || '').split(/[^0-9]+/g)
    .map(s => parseInt(s, 10))
    .filter(n => Number.isFinite(n) && n > 0)
)];

const resMap = {
  '720p':  { w: 1280, h: 720  },
  '1080p': { w: 1920, h: 1080 },
  '1440p': { w: 2560, h: 1440 },
  '2160p': { w: 3840, h: 2160 },
};

// ── TopBar ────────────────────────────────────────────────────────────────────

function TopBar({ stageRef, layerRef, onGoHome, onTogglePreview }) {
  const {
    nodes, links, slideBreaks, captureFrame,
    activeProject, renameActiveProject,
    isExporting, exportProgress, exportStatus,
    setExporting, setExportProgress, setExportStatus,
    alignment, setAlignment,
  } = useStore();

  const fileInputRef     = useRef(null);
  const slideTplInputRef = useRef(null);

  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal]         = useState('');
  const [openMenu, setOpenMenu]       = useState(null); // 'file' | 'export' | 'view' | 'settings'

  // Export options (live in TopBar state, surfaced in ExportSettingsPanel)
  const [resolution,         setResolution]         = useState('1080p');
  const [gifLoopableMode,    setGifLoopableMode]    = useState('none');
  const [gifLoopableCustom,  setGifLoopableCustom]  = useState('');
  const [gifSpeed,           setGifSpeed]           = useState('1x');
  const [gifBorder,          setGifBorder]          = useState('No border');
  const [slideTpl,           setSlideTpl]           = useState(null);
  const [placeholderColor,   setPlaceholderColor]   = useState('#FF00FF');
  const [slideBgMode,        setSlideBgMode]        = useState('Image');

  // Panel visibility
  const [exportPanelOpen, setExportPanelOpen] = useState(false);
  const [loopPopupOpen,   setLoopPopupOpen]   = useState(false);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleImportSlide = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
      if (isSvg) {
        const svgBytes = new Uint8Array(await file.arrayBuffer());
        const svgText  = new TextDecoder().decode(svgBytes);
        const blobUrl  = URL.createObjectURL(new Blob([svgBytes], { type: 'image/svg+xml' }));
        const img = await new Promise((res, rej) => {
          const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Could not load SVG')); im.src = blobUrl;
        });
        let natW = img.naturalWidth || 0;
        let natH = img.naturalHeight || 0;
        if (!natW || !natH) {
          const m = /viewBox\s*=\s*["']([\d.\-eE\s,]+)["']/i.exec(svgText);
          if (m) { const p = m[1].trim().split(/[\s,]+/).map(Number); if (p.length === 4 && p[2] > 0 && p[3] > 0) { natW = p[2]; natH = p[3]; } }
        }
        if (!natW || !natH) { natW = 1920; natH = 1080; }
        const renderW = Math.min(4096, Math.max(1920, Math.round(natW * 2)));
        const renderH = Math.max(1, Math.round(renderW * (natH / natW)));
        const canvas = document.createElement('canvas');
        canvas.width = renderW; canvas.height = renderH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, renderW, renderH);
        URL.revokeObjectURL(blobUrl);
        const { data } = ctx.getImageData(0, 0, renderW, renderH);
        const bgColor = `#${[data[0], data[1], data[2]].map(v => v.toString(16).padStart(2, '0')).join('')}`;
        const url = canvas.toDataURL('image/png');
        const bin = atob(url.split(',')[1]);
        const pngBytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) pngBytes[i] = bin.charCodeAt(i);
        setSlideTpl({ width: renderW, height: renderH, data, imageBytes: pngBytes, imageExt: 'png', svgBytes, bgColor, name: file.name });
        return;
      }
      const originalBytes = new Uint8Array(await file.arrayBuffer());
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const bgColor = `#${[data[0], data[1], data[2]].map(v => v.toString(16).padStart(2, '0')).join('')}`;
      const extByType = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif' };
      let imageBytes = originalBytes;
      let imageExt   = extByType[file.type];
      if (!imageExt) {
        const url = canvas.toDataURL('image/png');
        const bin = atob(url.split(',')[1]);
        imageBytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) imageBytes[i] = bin.charCodeAt(i);
        imageExt = 'png';
      }
      setSlideTpl({ width: bitmap.width, height: bitmap.height, data, imageBytes, imageExt, bgColor, name: file.name });
      bitmap.close?.();
    } catch (err) {
      alert(`Could not load slide image:\n${err.message}`);
    }
  };

  const handleDownload = () => {
    if (!activeProject) return;
    downloadProjectFile({ version: 1, ...activeProject, nodes, links, slideBreaks, captureFrame });
  };

  const handleOpenFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const { setActiveProject, loadProjectData } = useStore.getState();
        const project = parseProjectFile(ev.target.result);
        writeProject(project);
        setActiveProject({ id: project.id, name: project.name, createdAt: project.createdAt });
        loadProjectData({ nodes: project.nodes, links: project.links, slideBreaks: project.slideBreaks ?? project.slides ?? [], captureFrame: project.captureFrame ?? null });
      } catch (err) {
        alert(`Could not open file:\n${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const commitName = () => {
    const name = nameVal.trim() || 'Untitled';
    renameActiveProject(name);
    if (activeProject) writeProject({ version: 1, ...activeProject, name, nodes, links, slideBreaks, captureFrame });
    setEditingName(false);
  };

  const handleExportGifPackage = useCallback(async () => {
    if (!nodes.length) { alert('Add at least one node before exporting.'); return; }
    let slideTemplate = null;
    if (slideTpl) {
      const rect = findPlaceholderRect(slideTpl.data, slideTpl.width, slideTpl.height, placeholderColor);
      if (!rect) {
        alert(`No ${placeholderColor} rectangle found in the imported slide.`);
        return;
      }
      slideTemplate = {
        imageBytes: slideTpl.imageBytes,
        imageExt: slideTpl.imageExt,
        svgBytes: slideTpl.svgBytes ?? null,
        width: slideTpl.width,
        height: slideTpl.height,
        rect,
        bgMode: slideBgMode === 'Image' ? 'image' : 'solid',
        bgColor: slideTpl.bgColor,
      };
    }
    setExporting(true);
    setExportProgress(0);
    setExportStatus('Preparing GIF/APNG package…');
    try {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      layerRef.current?.draw();
      const { w, h } = resMap[resolution];
      const loopArgs = gifLoopableMode === 'custom'
        ? { gifLoopable: parseSlideList(gifLoopableCustom) }
        : { gifLoopableMode };
      await exportGifPackageZip({
        stageRef, layerRef, nodes, links,
        projectName: activeProject?.name ?? 'IRIS',
        exportWidth: w, exportHeight: h,
        viewport: useStore.getState().captureFrame,
        slideBreaks, gifScale: 1,
        gifSpeed: Math.max(0.25, parseFloat(String(gifSpeed).replace('x', '')) || 1),
        gifBorder: gifBorder === 'Teal frame' ? 'frame' : gifBorder === 'Teal line' ? 'line' : 'none',
        slideTemplate, ...loopArgs,
        onProgress: p => setExportProgress(p),
        onStatus:   s => setExportStatus(s),
      });
    } catch (err) {
      console.error('Export error:', err);
      alert(`Export failed:\n${err.message}`);
    } finally {
      setExporting(false);
      setExportStatus('');
    }
  }, [nodes, links, slideBreaks, captureFrame, slideTpl, placeholderColor, slideBgMode, resolution, gifSpeed, gifBorder, gifLoopableMode, gifLoopableCustom, activeProject, stageRef, layerRef, setExporting, setExportProgress, setExportStatus]);

  const closeMenu = useCallback(() => setOpenMenu(null), []);
  const toggleMenu = (name) => setOpenMenu(prev => prev === name ? null : name);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{
      height: 52,
      background: 'var(--panel-bg)',
      borderBottom: '1px solid var(--border-strong)',
      display: 'flex',
      alignItems: 'center',
      flexShrink: 0,
      position: 'relative',
      zIndex: 200,
      userSelect: 'none',
      gap: 2,
    }}>
      {/* IRIS logo */}
      <button
        onClick={onGoHome}
        title="Back to projects"
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '0 14px 0 14px', height: '100%',
          borderRight: '1px solid var(--border-strong)',
          flexShrink: 0,
        }}
      >
        <img src="/IrisLogo.svg" alt="IRIS" style={{ width: 38, height: 38, flexShrink: 0 }} />
        <span style={{
          fontFamily: 'Lalezar, sans-serif',
          fontSize: 28,
          color: 'var(--text-main)',
          letterSpacing: '0.04em',
          lineHeight: 1,
        }}>
          IRIS
        </span>
      </button>

      {/* Project name */}
      <div style={{ padding: '0 8px', flexShrink: 0 }}>
        {editingName ? (
          <input
            autoFocus
            value={nameVal}
            onChange={e => setNameVal(e.target.value)}
            onBlur={commitName}
            onKeyDown={e => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditingName(false); }}
            style={{
              background: 'var(--panel-bg-3)',
              border: '1px solid var(--purple-border-soft)',
              borderRadius: 5,
              color: 'var(--text-main)',
              fontSize: 12,
              fontWeight: 600,
              padding: '3px 8px',
              width: 160,
            }}
          />
        ) : (
          <span
            onClick={() => { setNameVal(activeProject?.name ?? ''); setEditingName(true); }}
            title="Click to rename"
            style={{
              color: 'var(--text-muted)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'text',
              maxWidth: 180,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'block',
            }}
          >
            {activeProject?.name ?? 'Untitled'}
          </span>
        )}
      </div>

      <VDivider />

      {/* ── Menu bar ── */}
      <div style={{ display: 'flex', alignItems: 'stretch', height: '100%' }}>

        <DropMenu label="File" open={openMenu === 'file'} onToggle={() => toggleMenu('file')} onClose={closeMenu}>
          <MItem label="Open file…"         onClick={() => { closeMenu(); fileInputRef.current?.click(); }} />
          <MItem label="Download project"   onClick={() => { closeMenu(); handleDownload(); }} />
        </DropMenu>

        <DropMenu label="Export" open={openMenu === 'export'} onToggle={() => toggleMenu('export')} onClose={closeMenu}>
          <MItem
            label="GIF package"
            hasSub
            disabled={isExporting}
            sub={
              <>
                <MItem label="Export now"     onClick={() => { closeMenu(); handleExportGifPackage(); }} />
                <MSep />
                <MItem label="Settings…"      onClick={() => { closeMenu(); setExportPanelOpen(true); }} />
              </>
            }
          />
          <MItem label="PPTX"   hasSub disabled sub={<MItem label="Coming soon" disabled />} />
          <MItem label="MP4"    hasSub disabled sub={<MItem label="Coming soon" disabled />} />
          <MSep />
          <MItem label="Export settings…" onClick={() => { closeMenu(); setExportPanelOpen(true); }} />
        </DropMenu>

        <DropMenu label="View" open={openMenu === 'view'} onToggle={() => toggleMenu('view')} onClose={closeMenu}>
          <MItem label="Preview" shortcut="P" onClick={() => { closeMenu(); onTogglePreview?.(); }} />
          <MItem label="Documentation" onClick={() => { closeMenu(); import('../docsNav').then(m => m.docsNav.open('')); }} />
        </DropMenu>

        <DropMenu label="Settings" open={openMenu === 'settings'} onToggle={() => toggleMenu('settings')} onClose={closeMenu}>
          <MItem label="Loop frames…" onClick={() => { closeMenu(); setLoopPopupOpen(true); }} />
        </DropMenu>

      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Export progress */}
      {isExporting && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 12 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {exportStatus}
          </span>
          <ProgressBar value={exportProgress} />
          <span style={{ color: 'var(--success-main)', fontSize: 11, minWidth: 34, textAlign: 'right' }}>
            {Math.round(exportProgress * 100)}%
          </span>
        </div>
      )}

      {/* Snap controls */}
      {!isExporting && (
        <>
          <ToggleChip
            label="Snap"
            enabled={alignment.snapEnabled}
            onToggle={() => setAlignment({ snapEnabled: !alignment.snapEnabled })}
          />
          <SnapSettingsMenu alignment={alignment} setAlignment={setAlignment} />
          <VDivider />
          <ToggleChip
            label="Ghosts"
            enabled={alignment.showGhostNodes ?? false}
            onToggle={() => setAlignment({ showGhostNodes: !alignment.showGhostNodes })}
          />
        </>
      )}

      <div style={{ width: 8 }} />

      {/* Hidden inputs */}
      <input ref={fileInputRef}     type="file" accept=".echoproj,.json" style={{ display: 'none' }} onChange={handleOpenFile} />
      <input ref={slideTplInputRef} type="file" accept=".svg,image/svg+xml,image/*" style={{ display: 'none' }} onChange={handleImportSlide} />

      {/* Export Settings panel */}
      {exportPanelOpen && (
        <ExportSettingsPanel
          onClose={() => setExportPanelOpen(false)}
          onExport={() => { setExportPanelOpen(false); handleExportGifPackage(); }}
          resolution={resolution}           setResolution={setResolution}
          gifSpeed={gifSpeed}               setGifSpeed={setGifSpeed}
          gifBorder={gifBorder}             setGifBorder={setGifBorder}
          slideTpl={slideTpl}               setSlideTpl={setSlideTpl}
          placeholderColor={placeholderColor} setPlaceholderColor={setPlaceholderColor}
          slideBgMode={slideBgMode}         setSlideBgMode={setSlideBgMode}
          slideTplInputRef={slideTplInputRef}
          gifLoopableMode={gifLoopableMode} setGifLoopableMode={setGifLoopableMode}
          gifLoopableCustom={gifLoopableCustom} setGifLoopableCustom={setGifLoopableCustom}
          isExporting={isExporting}
        />
      )}

      {/* Loop popup */}
      {loopPopupOpen && (
        <LoopPopup
          onClose={() => setLoopPopupOpen(false)}
          slideBreaks={slideBreaks}
          gifLoopableMode={gifLoopableMode}   setGifLoopableMode={setGifLoopableMode}
          gifLoopableCustom={gifLoopableCustom} setGifLoopableCustom={setGifLoopableCustom}
        />
      )}
    </div>
  );
}

// ── Dropdown menu ─────────────────────────────────────────────────────────────

function DropMenu({ label, open, onToggle, onClose, children }) {
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const [panelLeft, setPanelLeft] = useState(0);

  useEffect(() => {
    if (!open) return;
    // Anchor panel to the button's left edge, clamped so it doesn't overflow right
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      const panelW = 200;
      const left = Math.min(rect.left, window.innerWidth - panelW - 8);
      setPanelLeft(Math.max(0, left));
    }
    const handler = (e) => {
      if (
        btnRef.current?.contains(e.target) ||
        panelRef.current?.contains(e.target)
      ) return;
      onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose]);

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'stretch' }}>
      <button
        ref={btnRef}
        onClick={onToggle}
        style={{
          background: open ? 'var(--purple-surface-soft)' : 'transparent',
          border: 'none',
          borderBottom: open ? '2px solid var(--purple-bright)' : '2px solid transparent',
          color: open ? 'var(--text-main)' : 'var(--text-muted)',
          padding: '0 11px',
          fontSize: 12,
          fontWeight: 500,
          cursor: 'pointer',
          height: '100%',
          borderRadius: 0,
          letterSpacing: '0.01em',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </button>

      {open && (
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            top: 52,
            left: panelLeft,
            minWidth: 200,
            background: 'linear-gradient(180deg, var(--panel-bg-2), var(--panel-bg))',
            border: '1px solid var(--border-strong)',
            borderRadius: '0 8px 8px 8px',
            padding: '4px 0',
            boxShadow: '0 8px 28px var(--menu-shadow)',
            zIndex: 500,
            animation: 'fadeSlideDown 0.1s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// ── Menu item (with optional flyout submenu) ───────────────────────────────────

function MItem({ label, onClick, disabled = false, shortcut, hasSub = false, sub }) {
  const [subOpen, setSubOpen] = useState(false);
  const [subPos,  setSubPos]  = useState({ top: 0, left: 0 });
  const rowRef  = useRef(null);
  const subRef  = useRef(null);

  const openSub = () => {
    if (!hasSub || disabled) return;
    const rect = rowRef.current?.getBoundingClientRect();
    if (rect) {
      // Try to open to the right; if that would overflow, open to the left
      const subW = 180;
      const goRight = rect.right + subW < window.innerWidth - 8;
      setSubPos({
        top: rect.top,
        left: goRight ? rect.right : rect.left - subW,
      });
    }
    setSubOpen(true);
  };

  const closeSub = useCallback((e) => {
    if (
      rowRef.current?.contains(e.target) ||
      subRef.current?.contains(e.target)
    ) return;
    setSubOpen(false);
  }, []);

  useEffect(() => {
    if (!subOpen) return;
    document.addEventListener('mouseover', closeSub);
    return () => document.removeEventListener('mouseover', closeSub);
  }, [subOpen, closeSub]);

  return (
    <>
      <div
        ref={rowRef}
        onMouseEnter={openSub}
        onClick={!disabled && !hasSub ? onClick : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 14px',
          fontSize: 12,
          color: disabled ? 'var(--text-faint)' : 'var(--text-muted)',
          cursor: disabled ? 'default' : 'pointer',
          userSelect: 'none',
          gap: 16,
          transition: 'background 70ms, color 70ms',
        }}
        onMouseOver={e => {
          if (!disabled) {
            e.currentTarget.style.background = 'var(--purple-hover)';
            e.currentTarget.style.color = disabled ? '' : 'var(--text-main)';
          }
        }}
        onMouseOut={e => {
          e.currentTarget.style.background = '';
          e.currentTarget.style.color = disabled ? 'var(--text-faint)' : 'var(--text-muted)';
        }}
      >
        <span>{label}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {shortcut && <span style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'monospace' }}>{shortcut}</span>}
          {hasSub && <span style={{ fontSize: 9, color: 'var(--text-dim)', opacity: disabled ? 0.4 : 1 }}>▶</span>}
        </span>
      </div>

      {subOpen && sub && (
        <div
          ref={subRef}
          style={{
            position: 'fixed',
            top: subPos.top,
            left: subPos.left,
            minWidth: 170,
            background: 'linear-gradient(180deg, var(--panel-bg-2), var(--panel-bg))',
            border: '1px solid var(--border-strong)',
            borderRadius: 8,
            padding: '4px 0',
            boxShadow: '0 8px 28px var(--menu-shadow)',
            zIndex: 600,
            animation: 'fadeSlideDown 0.08s ease',
          }}
        >
          {sub}
        </div>
      )}
    </>
  );
}

function MSep() {
  return <div style={{ height: 1, background: 'var(--border-strong)', margin: '3px 0' }} />;
}

// ── Export Settings Panel ─────────────────────────────────────────────────────

function ExportSettingsPanel({
  onClose, onExport, isExporting,
  resolution, setResolution,
  gifSpeed, setGifSpeed,
  gifBorder, setGifBorder,
  slideTpl, setSlideTpl,
  placeholderColor, setPlaceholderColor,
  slideBgMode, setSlideBgMode,
  slideTplInputRef,
  gifLoopableMode, setGifLoopableMode,
  gifLoopableCustom, setGifLoopableCustom,
}) {
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const sRow = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 12 };
  const sLabel = { fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, width: 88 };
  const sSelect = {
    flex: 1, minWidth: 0,
    background: 'var(--panel-bg-3)',
    border: '1px solid var(--border-strong)',
    borderRadius: 5,
    color: 'var(--text-main)',
    padding: '4px 8px',
    fontSize: 12,
  };

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top: 56,
        left: 8,
        width: 288,
        background: 'linear-gradient(180deg, var(--panel-bg-2), var(--panel-bg))',
        border: '1px solid var(--border-strong)',
        borderRadius: 10,
        padding: '14px 16px 16px',
        boxShadow: '0 12px 40px var(--menu-shadow)',
        zIndex: 500,
        animation: 'fadeSlideDown 0.15s cubic-bezier(0.16, 1, 0.3, 1)',
        maxHeight: 'calc(100vh - 72px)',
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--purple-bright)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          Export Settings
        </span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 16, padding: '0 2px', lineHeight: 1 }}>×</button>
      </div>

      {/* Output */}
      <PanelSection label="Output" />
      <div style={sRow}>
        <span style={sLabel}>Resolution</span>
        <select value={resolution} onChange={e => setResolution(e.target.value)} style={sSelect}>
          {['720p', '1080p', '1440p', '2160p'].map(r => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <div style={sRow}>
        <span style={sLabel}>Playback speed</span>
        <select value={gifSpeed} onChange={e => setGifSpeed(e.target.value)} style={sSelect}>
          {['0.5x', '0.75x', '1x', '1.25x', '1.5x', '2x', '3x', '4x'].map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div style={sRow}>
        <span style={sLabel}>Border</span>
        <select value={gifBorder} onChange={e => setGifBorder(e.target.value)} style={sSelect}>
          {['No border', 'Teal frame', 'Teal line'].map(b => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>

      {/* Loop */}
      <div style={{ height: 1, background: 'var(--border-strong)', margin: '10px 0 12px' }} />
      <PanelSection label="Loop" />
      <div style={sRow}>
        <span style={sLabel}>Mode</span>
        <select value={gifLoopableMode} onChange={e => setGifLoopableMode(e.target.value)} style={sSelect}>
          <option value="none">Off</option>
          <option value="last">Last slide</option>
          <option value="all">All slides</option>
          <option value="custom">Custom…</option>
        </select>
      </div>
      {gifLoopableMode === 'custom' && (
        <div style={sRow}>
          <span style={sLabel}>Slides</span>
          <input
            value={gifLoopableCustom}
            onChange={e => setGifLoopableCustom(e.target.value)}
            placeholder="e.g. 1, 3, 5"
            style={{ ...sSelect, padding: '4px 8px' }}
          />
        </div>
      )}

      {/* Slide template */}
      <div style={{ height: 1, background: 'var(--border-strong)', margin: '10px 0 12px' }} />
      <PanelSection label="Slide Template" />
      <div style={{ ...sRow, alignItems: 'flex-start' }}>
        <span style={{ ...sLabel, paddingTop: 5 }}>File</span>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button
            onClick={() => slideTplInputRef.current?.click()}
            style={{
              width: '100%',
              background: slideTpl ? 'var(--purple-surface-soft)' : 'var(--panel-bg-3)',
              border: `1px solid ${slideTpl ? 'var(--purple-border-soft)' : 'var(--border-strong)'}`,
              borderRadius: 5,
              color: slideTpl ? 'var(--text-main)' : 'var(--text-muted)',
              fontSize: 11,
              padding: '5px 8px',
              cursor: 'pointer',
              textAlign: 'left',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {slideTpl ? slideTpl.name : 'Import SVG / PNG / JPEG…'}
          </button>
          {slideTpl && (
            <button
              onClick={() => setSlideTpl(null)}
              style={{
                background: 'none',
                border: '1px solid var(--border-strong)',
                borderRadius: 5,
                color: 'var(--text-muted)',
                fontSize: 11,
                padding: '4px 8px',
                cursor: 'pointer',
                width: '100%',
              }}
            >
              Remove template
            </button>
          )}
        </div>
      </div>
      {slideTpl && (
        <>
          <div style={sRow}>
            <span style={sLabel}>Marker color</span>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="color"
                value={placeholderColor}
                onChange={e => setPlaceholderColor(e.target.value)}
                title="Color of the placeholder rectangle in your slide"
                style={{ width: 32, height: 26, padding: 0, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 5 }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{placeholderColor}</span>
            </div>
          </div>
          <div style={sRow}>
            <span style={sLabel}>Background</span>
            <select value={slideBgMode} onChange={e => setSlideBgMode(e.target.value)} style={sSelect}>
              <option value="Image">Image</option>
              <option value="Solid color">Solid color</option>
            </select>
          </div>
        </>
      )}

      {/* Export button */}
      <button
        onClick={onExport}
        disabled={isExporting}
        style={{
          marginTop: 16,
          width: '100%',
          background: 'var(--purple-main, var(--purple-bright))',
          border: 'none',
          borderRadius: 7,
          color: '#fff',
          fontSize: 12,
          fontWeight: 600,
          padding: '8px 0',
          cursor: isExporting ? 'not-allowed' : 'pointer',
          opacity: isExporting ? 0.5 : 1,
          letterSpacing: '0.02em',
        }}
      >
        Export GIF package
      </button>
    </div>
  );
}

function PanelSection({ label }) {
  return (
    <div style={{
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      color: 'var(--purple-bright)',
      marginBottom: 8,
    }}>
      {label}
    </div>
  );
}

// ── Loop Popup ────────────────────────────────────────────────────────────────

function LoopPopup({ onClose, slideBreaks, gifLoopableMode, setGifLoopableMode, gifLoopableCustom, setGifLoopableCustom }) {
  const ref = useRef(null);
  const slideCount = (slideBreaks?.length ?? 0) + 1;

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const customSet = gifLoopableMode === 'custom'
    ? new Set(parseSlideList(gifLoopableCustom))
    : null;

  const isLooping = (n) => {
    if (gifLoopableMode === 'all')  return true;
    if (gifLoopableMode === 'last') return n === slideCount;
    if (gifLoopableMode === 'custom') return !!customSet?.has(n);
    return false;
  };

  const toggleSlide = (n) => {
    const current = parseSlideList(gifLoopableCustom);
    const has = current.includes(n);
    const next = has ? current.filter(x => x !== n) : [...current, n].sort((a, b) => a - b);
    setGifLoopableMode(next.length ? 'custom' : 'none');
    setGifLoopableCustom(next.join(', '));
  };

  const modeBtn = (mode, labelText) => (
    <button
      key={mode}
      onClick={() => setGifLoopableMode(mode)}
      style={{
        background: gifLoopableMode === mode ? 'var(--purple-surface-panel)' : 'var(--panel-bg)',
        border: `1px solid ${gifLoopableMode === mode ? 'var(--purple-border-strong)' : 'var(--border-strong)'}`,
        borderRadius: 6,
        color: gifLoopableMode === mode ? 'var(--text-main)' : 'var(--text-muted)',
        fontSize: 11,
        padding: '4px 12px',
        cursor: 'pointer',
      }}
    >
      {labelText}
    </button>
  );

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top: 56,
        left: 8,
        background: 'linear-gradient(180deg, var(--panel-bg-2), var(--panel-bg))',
        border: '1px solid var(--border-strong)',
        borderRadius: 12,
        padding: '16px 18px 18px',
        boxShadow: '0 16px 48px var(--menu-shadow)',
        zIndex: 600,
        animation: 'fadeSlideDown 0.15s cubic-bezier(0.16, 1, 0.3, 1)',
        maxWidth: 'calc(100vw - 16px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--purple-bright)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          GIF Loop
        </span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 16, padding: '0 2px', lineHeight: 1 }}>×</button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {modeBtn('none', 'Off')}
        {modeBtn('last', 'Last slide')}
        {modeBtn('all',  'All slides')}
      </div>

      {/* Slide frames */}
      <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 4 }}>
        {Array.from({ length: slideCount }, (_, i) => i + 1).map(n => {
          const looping = isLooping(n);
          return (
            <div
              key={n}
              onClick={() => toggleSlide(n)}
              title={looping ? 'Click to disable loop' : 'Click to enable loop'}
              style={{
                flexShrink: 0,
                width: 96,
                borderRadius: 8,
                border: `2px solid ${looping ? 'var(--purple-bright)' : 'var(--border-strong)'}`,
                background: 'var(--app-bg)',
                cursor: 'pointer',
                overflow: 'hidden',
                transition: 'border-color 0.1s',
              }}
            >
              <div style={{
                height: 60,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: looping ? 'var(--purple-surface-soft)' : 'var(--panel-bg)',
                fontSize: 22,
                fontWeight: 700,
                color: looping ? 'var(--purple-bright)' : 'var(--text-faint)',
                fontFamily: 'monospace',
                transition: 'background 0.1s, color 0.1s',
              }}>
                {n}
              </div>
              <div style={{
                padding: '4px 0',
                textAlign: 'center',
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: looping ? 'var(--purple-bright)' : 'var(--text-faint)',
                transition: 'color 0.1s',
              }}>
                {looping ? '↺ Loop' : 'No loop'}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 12, fontSize: 10, color: 'var(--text-faint)' }}>
        Click a slide card to toggle — or use the mode buttons above
      </div>
    </div>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ value }) {
  return (
    <div style={{ width: 100, height: 4, background: 'var(--panel-bg-3)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{
        width: `${Math.round(value * 100)}%`,
        height: '100%',
        background: 'linear-gradient(90deg, var(--success-main), var(--success-bright))',
        borderRadius: 2,
        transition: 'width 0.15s',
      }} />
    </div>
  );
}

// ── Snap settings ─────────────────────────────────────────────────────────────

function SnapSettingsMenu({ alignment, setAlignment }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const Row = ({ label, settingKey, disabled = false }) => (
    <label style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 18, padding: '5px 6px', borderRadius: 6,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.4 : 1,
      fontSize: 12, color: 'var(--text-main)', whiteSpace: 'nowrap',
    }}>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={!!alignment[settingKey]}
        disabled={disabled}
        onChange={() => setAlignment({ [settingKey]: !alignment[settingKey] })}
        style={{ accentColor: 'var(--purple-bright)', cursor: disabled ? 'not-allowed' : 'pointer' }}
      />
    </label>
  );

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Snapping & grid settings"
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: open ? 'var(--purple-surface-soft)' : 'var(--panel-bg)',
          border: `1px solid ${open ? 'var(--purple-border-soft)' : 'var(--border-strong)'}`,
          borderRadius: 999,
          color: 'var(--text-muted)',
          padding: '4px 10px',
          fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
        }}
      >
        <span>Settings</span>
        <span style={{ fontSize: 9 }}>▼</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 8px)',
          right: 0,
          width: 224,
          padding: '8px 8px 6px',
          background: 'linear-gradient(180deg, var(--panel-bg-2), var(--panel-bg))',
          border: '1px solid var(--border-strong)',
          borderRadius: 10,
          boxShadow: '0 10px 30px var(--menu-shadow)',
          zIndex: 300,
          animation: 'fadeSlideDown 0.14s cubic-bezier(0.16, 1, 0.3, 1)',
        }}>
          <Row label="Snap to objects"       settingKey="snapToObjects"  disabled={!alignment.snapEnabled} />
          <Row label="Snap to equal spacing" settingKey="snapSpacing"    disabled={!alignment.snapEnabled || !alignment.snapToObjects} />
          <Row label="Snap links to 90°"     settingKey="snapOrthogonal" disabled={!alignment.snapEnabled} />
          <Row label="Show guide lines"      settingKey="showGuides"     disabled={!alignment.snapEnabled} />
          <div style={{ height: 1, background: 'var(--border-strong)', margin: '6px 2px' }} />
          <Row label="Show grid"   settingKey="showGrid" />
          <Row label="Snap to grid" settingKey="snapToGrid" disabled={!alignment.snapEnabled} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18, padding: '5px 6px', fontSize: 12, color: 'var(--text-main)' }}>
            <span>Grid size</span>
            <select
              value={String(alignment.gridSize)}
              onChange={e => setAlignment({ gridSize: Number(e.target.value) })}
              style={{
                background: 'var(--panel-bg)',
                border: '1px solid var(--border-strong)',
                borderRadius: 6,
                color: 'var(--text-muted)',
                padding: '3px 24px 3px 8px',
                fontSize: 12,
                cursor: 'pointer',
                appearance: 'none',
              }}
            >
              {['8', '12', '16', '24', '36', '48', '72'].map(v => <option key={v} value={v}>{v} px</option>)}
            </select>
          </div>
          <div style={{ height: 1, background: 'var(--border-strong)', margin: '6px 2px' }} />
          <div style={{ padding: '4px 6px 2px', fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
            Alt — pause snapping while dragging<br />
            Shift — constrain drag to one axis<br />
            Arrows — nudge selection
          </div>
        </div>
      )}
    </div>
  );
}

// ── Toggle chip ───────────────────────────────────────────────────────────────

function ToggleChip({ label, enabled, onToggle, disabled = false }) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: enabled ? 'var(--purple-surface-soft)' : 'var(--panel-bg)',
        border: `1px solid ${enabled ? 'var(--purple-border-soft)' : 'var(--border-strong)'}`,
        borderRadius: 999,
        color: enabled ? 'var(--text-main)' : 'var(--text-muted)',
        padding: '4px 10px',
        fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1, whiteSpace: 'nowrap',
      }}
    >
      <span>{label}</span>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: enabled ? 'var(--purple-bright)' : 'var(--text-faint)',
        boxShadow: enabled ? '0 0 10px var(--purple-glow)' : 'none',
      }} />
    </button>
  );
}

// ── Vertical divider ──────────────────────────────────────────────────────────

function VDivider() {
  return <div style={{ width: 1, height: 22, background: 'var(--border-strong)', flexShrink: 0, margin: '0 2px' }} />;
}

export default TopBar;
