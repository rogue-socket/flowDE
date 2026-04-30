# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

FlowDE is a VS Code extension that provides graph-based code comprehension for Python projects. It performs static analysis using Lezer's Python parser and renders flowchart-oriented graphs via Cytoscape in a webview panel.

## Commands

```bash
npm run build          # esbuild extension + webview bundles
npm run watch          # watch mode for both targets
npm run check          # TypeScript strict type-check (no emit)
npm run package        # package VSIX via vsce
```

To test: press **F5** in VS Code to launch the Extension Development Host (runs `npm run build` as pre-launch task). There is no test suite.

## Architecture

Two-process model:

- **Extension host** (Node.js): `src/extension.ts` — registers `flowde.openGraphView` command, manages a single webview panel, watches `*.py` files with debounced refresh, handles source navigation.
- **Webview** (browser): `src/webview/main.ts` — Cytoscape rendering, layout (breadth-first vertical / CoSE force-directed), flow extraction via DFS, inspector panel.

Communication uses VS Code's `postMessage` protocol:
- Host → Webview: `graphData`, `graphError`
- Webview → Host: `ready`, `refreshGraph`, `navigateToNode`, `navigateToEdge`

## Graph Pipeline

Four-stage pipeline in `src/graph/`:

1. **Schema** (`schema.ts`) — Type contracts: `GraphNode`, `GraphEdge`, `GraphData`, layer/role/provenance enums.
2. **Indexing** (`pythonWorkspaceIndexer.ts`) — Scans `**/*.py`, parses ASTs with Lezer, extracts modules/classes/functions/calls/imports. Per-file caching by `mtime:size`.
3. **Resolution** (`pythonRelationResolver.ts`) — Converts indexed symbols into typed edges (call, dependency, contains, class-usage) with confidence scoring.
4. **Building** (`workspaceGraphBuilder.ts`) — Orchestrates indexing + resolution, computes layer stats, returns `GraphData` payload to the webview.

`semanticTypes.ts` defines internal intermediate types (`IndexedModule`, etc.) distinct from the wire-format schema.

## Build System

esbuild with two entry points configured in `esbuild.mjs`:
- `src/extension.ts` → `dist/extension.js` (Node/CJS, externals: `vscode`)
- `src/webview/main.ts` → `media/webview.js` (Browser/IIFE)

TypeScript strict mode, ES2022 target, source maps enabled.
