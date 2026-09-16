/* Excalidraw embed with SVG fallback. Loaded from a CDN; everything else is local. */
(function () {
  'use strict';
  const VERSION = '0.18.0';
  const REACT = '18.3.1';
  const CDN = 'https://esm.sh';
  const LOAD_TIMEOUT = 20000;
  let libPromise = null;

  function loadLib() {
    if (libPromise) return libPromise;
    libPromise = (async () => {
      if (!navigator.onLine) throw new Error('offline');
      window.EXCALIDRAW_ASSET_PATH = `${CDN}/@excalidraw/excalidraw@${VERSION}/dist/prod/`;
      if (!document.querySelector('link[data-excalidraw]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `${CDN}/@excalidraw/excalidraw@${VERSION}/dist/prod/index.css`;
        link.dataset.excalidraw = '1';
        document.head.appendChild(link);
      }
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('CDN load timeout')), LOAD_TIMEOUT));
      const load = (async () => {
        const [React, ReactDOM, Ex] = await Promise.all([
          import(`${CDN}/react@${REACT}`),
          import(`${CDN}/react-dom@${REACT}/client`),
          import(`${CDN}/@excalidraw/excalidraw@${VERSION}?deps=react@${REACT},react-dom@${REACT}`),
        ]);
        return { React: React.default || React, ReactDOM: ReactDOM.default || ReactDOM, Ex };
      })();
      return Promise.race([load, timeout]);
    })();
    libPromise.catch(() => { /* keep the rejection so later mounts fall back fast */ });
    return libPromise;
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function sceneKey(elements) {
    return JSON.stringify((elements || []).filter(e => !e.isDeleted).map(e => [e.id, e.version, e.x, e.y, e.width, e.height, e.text || '', e.points ? e.points.length : 0]));
  }

  /**
   * Mount a diagram into `host`.
   * opts: { file, svg, doc, id, onSave(scene, svgText), onState(text) }
   * returns { reload(), destroy() }
   */
  function mount(host, opts) {
    let root = null, api = null, destroyed = false, lastKey = null, timer = null;
    const state = document.createElement('div');
    state.className = 'd-state';
    const setState = (t) => { state.textContent = t; state.hidden = !t; };

    async function showFallback(reason) {
      host.classList.add('fallback');
      host.innerHTML = '';
      let shown = false;
      if (opts.svg) {
        try {
          const r = await fetch(`/file?path=${encodeURIComponent(opts.svg)}`, { cache: 'no-store' });
          if (r.ok) { const img = document.createElement('img'); img.alt = opts.id; img.src = URL.createObjectURL(await r.blob()); host.appendChild(img); shown = true; }
        } catch { /* no svg */ }
      }
      if (!shown) {
        const p = document.createElement('div'); p.className = 'muted';
        p.textContent = 'No SVG export stored yet - ask the agent to (re)generate the diagram.';
        host.appendChild(p);
      }
      const n = document.createElement('div'); n.className = 'notice';
      n.textContent = reason === 'offline' || /timeout|fetch|network|import/i.test(String(reason))
        ? 'Offline or CDN unreachable - diagram shown as SVG (read-only).'
        : `Excalidraw could not be loaded (${reason}) - diagram shown as SVG (read-only).`;
      host.appendChild(n);
      opts.onState && opts.onState('fallback');
    }

    async function loadScene() {
      try { return await fetchJson(`/file?path=${encodeURIComponent(opts.file)}`); }
      catch (e) { return { elements: [], appState: {}, files: {}, missing: true }; }
    }

    async function render() {
      host.classList.remove('fallback');
      host.innerHTML = '';
      host.appendChild(state);
      setState('loading Excalidraw…');
      let lib;
      try { lib = await loadLib(); } catch (e) { if (!destroyed) await showFallback(e.message); return; }
      if (destroyed) return;
      const scene = await loadScene();
      lastKey = sceneKey(scene.elements);
      const { React, ReactDOM, Ex } = lib;
      const el = document.createElement('div');
      el.style.height = '100%';
      host.appendChild(el);
      root = ReactDOM.createRoot(el);
      const onChange = (elements, appState, files) => {
        const key = sceneKey(elements);
        if (key === lastKey) return;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          lastKey = key;
          try {
            const json = Ex.serializeAsJSON(elements, appState, files, 'local');
            let svgText = '';
            try {
              const svg = await Ex.exportToSvg({ elements, appState: { ...appState, exportBackground: true, viewBackgroundColor: '#ffffff' }, files });
              svgText = svg.outerHTML;
            } catch { /* svg optional */ }
            setState('saving…');
            await opts.onSave(json, svgText);
            setState('');
          } catch (e) { setState('save failed: ' + e.message); }
        }, 1500);
      };
      root.render(React.createElement(Ex.Excalidraw, {
        initialData: { elements: scene.elements || [], appState: { viewBackgroundColor: '#ffffff', ...(scene.appState || {}), collaborators: new Map() }, files: scene.files || {}, scrollToContent: true },
        excalidrawAPI: (a) => { api = a; },
        onChange,
        UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: true, clearCanvas: false } },
      }));
      setState(scene.missing ? 'file not found - empty canvas' : '');
      opts.onState && opts.onState('ready');
    }

    render();
    return {
      async reload() {
        if (destroyed) return;
        if (!api) { render(); return; }
        const scene = await loadScene();
        lastKey = sceneKey(scene.elements);
        api.updateScene({ elements: scene.elements || [] });
        api.scrollToContent && api.scrollToContent(undefined, { fitToContent: true });
      },
      destroy() { destroyed = true; clearTimeout(timer); try { root && root.unmount(); } catch { /* ignore */ } host.innerHTML = ''; },
    };
  }

  window.SpecsDiagram = { mount, VERSION };
})();
