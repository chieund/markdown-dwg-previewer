/**
 * Stylesheet for the drawing webview.
 *
 * Kept apart from the editor provider so the same styles can be rendered
 * outside VS Code — the preview harness in scripts/ uses them to screenshot
 * the real interface.
 */
export const WEBVIEW_STYLES = `
    :root {
      --dwg-surface: var(--vscode-editorWidget-background, #252526);
      --dwg-border: var(--vscode-editorWidget-border, #5a5a5a);
      --dwg-divider: var(--vscode-panel-border, #3c3c3c);
      --dwg-text: var(--vscode-foreground, #cccccc);
      --dwg-muted: var(--vscode-descriptionForeground, #9d9d9d);
      --dwg-control: var(--vscode-button-secondaryBackground, #3c3c3c);
      --dwg-control-text: var(--vscode-button-secondaryForeground, #cccccc);
      --dwg-control-hover: var(--vscode-button-secondaryHoverBackground, #4a4a4a);
      --dwg-row-hover: var(--vscode-list-hoverBackground, #2d2d30);
      --dwg-focus: var(--vscode-focusBorder, #0098ff);
      --dwg-warning: var(--vscode-editorWarning-foreground, #cca700);
      --dwg-error: var(--vscode-errorForeground, #f48771);
      --dwg-canvas: #1e1e1e;
      --dwg-highlight: #ffcc00;
      --dwg-highlight-fill: rgba(255, 204, 0, 0.35);
    }

    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: var(--dwg-canvas); }
    #root { display: flex; flex-direction: column; width: 100%; height: 100%; }

    .dwg-toolbar {
      display: flex; align-items: center; gap: 8px; padding: 4px 8px; flex: 0 0 auto;
      background: var(--dwg-surface); border-bottom: 1px solid var(--dwg-divider);
      font-family: var(--vscode-font-family, sans-serif); font-size: 12px; color: var(--dwg-text);
    }
    .dwg-toolbar > *:not(.dwg-banner) { flex: 0 0 auto; }

    .dwg-page-select {
      background: var(--vscode-dropdown-background, #3c3c3c); color: var(--vscode-dropdown-foreground, #cccccc);
      border: 1px solid var(--vscode-dropdown-border, #5a5a5a); border-radius: 2px; padding: 2px 4px;
      font: inherit; max-width: 14em;
    }

    .dwg-layers { position: relative; }
    .dwg-layer-button, .dwg-layer-action, .dwg-export-button, .dwg-zoom-button {
      background: var(--dwg-control); color: var(--dwg-control-text);
      border: 1px solid var(--dwg-border); border-radius: 2px;
      cursor: pointer; font: inherit; white-space: nowrap;
    }
    .dwg-layer-button { padding: 3px 8px; }
    .dwg-layer-action { flex: 1; padding: 2px 6px; font-size: 11px; }
    .dwg-export-button { padding: 3px 8px; font-size: 11px; }
    .dwg-zoom-button { padding: 3px 0; font-size: 11px; min-width: 26px; }
    .dwg-layer-button:hover, .dwg-layer-action:hover,
    .dwg-export-button:hover, .dwg-zoom-button:hover { background: var(--dwg-control-hover); }

    .dwg-zoom { display: flex; gap: 2px; }

    .dwg-layer-button:focus-visible,
    .dwg-layer-action:focus-visible,
    .dwg-export-button:focus-visible,
    .dwg-banner-dismiss:focus-visible,
    .dwg-page-select:focus-visible,
    .dwg-layer-row input:focus-visible {
      outline: 1px solid var(--dwg-focus);
      outline-offset: 1px;
    }

    .dwg-layer-panel {
      position: absolute; top: calc(100% + 4px); left: 0; z-index: 10;
      min-width: 220px; max-height: 60vh; overflow-y: auto;
      background: var(--dwg-surface); border: 1px solid var(--dwg-border); border-radius: 3px;
      box-shadow: 0 4px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.5)); padding: 4px;
    }
    .dwg-layer-actions { display: flex; gap: 4px; padding: 2px 2px 6px; border-bottom: 1px solid var(--dwg-divider); margin-bottom: 4px; }
    .dwg-layer-filter {
      width: 100%; box-sizing: border-box; margin: 0 0 4px; padding: 3px 6px;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #5a5a5a);
      border-radius: 2px; font: inherit;
    }
    .dwg-layer-filter::placeholder { color: var(--dwg-muted); }
    .dwg-layer-row { display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-radius: 2px; }
    /* An author-set display beats the browser's [hidden] rule, so filtering out
       a row needs to say so explicitly. */
    .dwg-layer-row[hidden] { display: none; }
    .dwg-layer-row:hover { background: var(--dwg-row-hover); }
    .dwg-layer-label { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; cursor: pointer; }
    .dwg-layer-swatch { width: 10px; height: 10px; border-radius: 2px; flex: 0 0 auto; border: 1px solid #00000060; }
    .dwg-layer-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dwg-layer-count { flex: 0 0 auto; color: var(--dwg-muted); font-size: 11px; }
    .dwg-layer-isolate {
      flex: 0 0 auto; background: none; border: 1px solid transparent; border-radius: 2px;
      color: var(--dwg-muted); cursor: pointer; font: inherit; font-size: 10px;
      padding: 1px 5px; opacity: 0.4; transition: opacity 0.1s;
    }
    .dwg-layer-row:hover .dwg-layer-isolate,
    .dwg-layer-isolate:focus-visible { opacity: 1; }
    .dwg-layer-isolate:hover { background: var(--dwg-control-hover); color: var(--dwg-text); border-color: var(--dwg-border); }
    .dwg-layer-nomatch { padding: 8px 4px; color: var(--dwg-muted); font-size: 11px; text-align: center; }

    .dwg-export { display: flex; gap: 4px; }

    .dwg-search { position: relative; }
    .dwg-search-panel { width: 340px; }
    .dwg-search-input-row { display: flex; align-items: center; gap: 6px; }
    .dwg-search-input-row .dwg-layer-filter { flex: 1 1 auto; margin-bottom: 0; }
    .dwg-search-counter { flex: 0 0 auto; color: var(--dwg-muted); font-size: 11px; }
    .dwg-search-results { margin-top: 4px; }
    .dwg-search-group {
      padding: 6px 4px 2px; color: var(--dwg-muted); font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .dwg-search-row { cursor: pointer; }
    .dwg-search-current { background: var(--vscode-list-activeSelectionBackground, #04395e); }

    /* Selection: the drawing fades back and highlighted copies sit on top. */
    .dwg-dimmed { opacity: 0.3; }
    .dwg-highlight { pointer-events: none; }
    .dwg-highlight * { stroke: var(--dwg-highlight) !important; }
    .dwg-highlight text { fill: var(--dwg-highlight) !important; stroke: none !important; }
    .dwg-highlight [fill]:not([fill="none"]):not(text) { fill: var(--dwg-highlight-fill) !important; }

    .dwg-diff-title { color: var(--dwg-muted); max-width: 22em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dwg-diff-toggles { display: flex; gap: 10px; }
    .dwg-diff-toggle { display: flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap; }
    .dwg-diff-position { min-width: 4.5em; text-align: center; color: var(--dwg-muted); align-self: center; }
    .dwg-diff-unchanged { opacity: 0.35; }
    .dwg-diff-changedOld { opacity: 0.6; }
    .dwg-diff-marker { stroke-width: 1.5px; stroke-dasharray: 5 3; }

    .dwg-inspector {
      position: absolute; top: 8px; right: 8px; z-index: 5; width: 280px; max-height: calc(100% - 16px);
      overflow-y: auto; background: var(--dwg-surface); color: var(--dwg-text);
      border: 1px solid var(--dwg-border); border-radius: 3px;
      box-shadow: 0 4px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.5));
      font-family: var(--vscode-font-family, sans-serif); font-size: 12px;
    }
    .dwg-inspector-header {
      display: flex; align-items: center; gap: 6px; padding: 6px 8px;
      border-bottom: 1px solid var(--dwg-divider);
    }
    .dwg-inspector-title { flex: 1 1 auto; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dwg-inspector-close { background: none; border: none; color: var(--dwg-muted); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 2px; }
    .dwg-inspector-close:hover { color: var(--dwg-text); }
    .dwg-inspector-close:focus-visible { outline: 1px solid var(--dwg-focus); outline-offset: 1px; }
    .dwg-inspector-section {
      padding: 8px 8px 2px; color: var(--dwg-muted); font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .dwg-inspector-table { width: 100%; border-collapse: collapse; margin: 2px 0 6px; }
    .dwg-inspector-table td { padding: 2px 8px; vertical-align: top; word-break: break-word; }
    .dwg-inspector-label { color: var(--dwg-muted); width: 34%; white-space: nowrap; }
    .dwg-inspector-table .dwg-layer-swatch { display: inline-block; margin-right: 6px; vertical-align: -1px; }
    .dwg-inspector-hidden td { opacity: 0.6; font-style: italic; }

    .dwg-banner {
      display: flex; align-items: center; gap: 6px; min-width: 0; flex: 0 1 auto;
      color: var(--dwg-warning);
    }
    .dwg-banner-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dwg-banner-dismiss {
      flex: 0 0 auto; background: none; border: none; color: inherit;
      cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px;
    }

    .dwg-canvas { flex: 1 1 auto; overflow: hidden; background: var(--dwg-canvas); position: relative; }

    /* Sits over the canvas when there is nothing to look at, so an empty view
       always explains itself instead of showing a blank rectangle. */
    .dwg-empty {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 10px;
      padding: 24px; text-align: center; pointer-events: none;
      font-family: var(--vscode-font-family, sans-serif);
    }
    .dwg-empty-title { font-size: 15px; color: var(--dwg-text); }
    .dwg-empty-detail { font-size: 12px; color: var(--dwg-muted); max-width: 48ch; line-height: 1.6; }
    .dwg-empty-action {
      pointer-events: auto; margin-top: 4px; padding: 4px 12px; font: inherit; font-size: 12px;
      background: var(--dwg-control); color: var(--dwg-control-text);
      border: 1px solid var(--dwg-border); border-radius: 2px; cursor: pointer;
    }
    .dwg-empty-action:hover { background: var(--dwg-control-hover); }
    .dwg-empty-action:focus-visible { outline: 1px solid var(--dwg-focus); outline-offset: 1px; }

    .dwg-statusbar {
      display: flex; align-items: center; gap: 14px; flex: 0 0 auto;
      padding: 3px 10px; background: var(--dwg-surface);
      border-top: 1px solid var(--dwg-divider); color: var(--dwg-muted);
      font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
      white-space: nowrap; overflow: hidden;
    }
    .dwg-status-spacer { flex: 1 1 auto; }
    .dwg-status-hint { flex: 0 0 auto; opacity: 0.75; }
    .dwg-error { color: var(--dwg-error); padding: 16px; font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; margin: 0; }
    .dwg-loading {
      display: flex; align-items: center; justify-content: center; gap: 12px;
      width: 100%; height: 100%; color: var(--dwg-text);
      font-family: var(--vscode-font-family, sans-serif); font-size: 14px;
    }
    .dwg-spinner {
      width: 24px; height: 24px; border: 3px solid var(--dwg-control);
      border-top-color: var(--vscode-progressBar-background, #0098ff); border-radius: 50%;
      animation: dwg-spin 0.8s linear infinite;
    }
    @keyframes dwg-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .dwg-spinner { animation-duration: 3s; }
    }
`;
