# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

FlowDE is a VS Code extension that provides graph-based code comprehension for Python projects. It performs static analysis using Lezer's Python parser and renders flowchart-oriented graphs via Cytoscape in a webview panel. There is no test suite — validation is manual via the Extension Development Host.

## Commands

```bash
npm run build          # esbuild extension + webview bundles
npm run watch          # watch mode for both targets
npm run check          # TypeScript strict type-check (no emit)
npm run package        # package VSIX via vsce
```

To test: press **F5** in VS Code to launch the Extension Development Host (runs `npm run build` as pre-launch task). No linter is configured (`npm run lint` is a no-op).

## Architecture

Two-process model with separate bundles that do not share modules:

- **Extension host** (Node.js): `src/extension.ts` → `dist/extension.js` (CJS, `node20`). Registers `flowde.openGraphView`, manages a singleton webview panel, watches `*.py` files, handles source navigation.
- **Webview** (browser): `src/webview/main.ts` → `media/webview.js` (IIFE, `es2020`). Cytoscape rendering, layout, DFS flow extraction, inspector panel.

The webview re-declares `GraphNode`/`GraphEdge` interfaces locally rather than importing from `schema.ts` — this is intentional because the two bundles have separate module graphs.

### Message Protocol

Host → Webview: `graphData`, `graphError`
Webview → Host: `ready`, `refreshGraph`, `navigateToNode`, `navigateToEdge`

Note: `navigateToEdge` sends `{ edgeId, filePath, line }` but the host ignores `edgeId` — it only uses `filePath` and `line`.

### Refresh System (three layers)

1. **Debounce** (250ms): `scheduleRefresh` resets timer on each `*.py` file system event.
2. **In-flight guard**: `refreshInFlight` flag prevents concurrent rebuilds.
3. **Single-slot queue**: If a refresh request arrives while one is running, `refreshQueued` ensures exactly one retry after the current rebuild completes.

Rapid file saves coalesce into at most two consecutive rebuilds.

### Panel Lifecycle

- Singleton: only one `FlowDEPanel` exists at a time; re-invoking the command reveals the existing panel.
- `retainContextWhenHidden: true`: Cytoscape instance and all JS state survive tab switches (memory is never freed until panel close).
- CSP uses a random nonce; only `media/webview.js` and `media/styles.css` are allowed. No inline scripts/styles.
- `localResourceRoots` restricted to `media/` — assets from other directories are inaccessible.
- `extensionKind: ["workspace"]` — will not run in web or remote extension hosts.

### Multi-root Workspace Caveat

If no editor is active, `resolveWorkspaceFolder` falls back to `workspaceFolders?.[0]`. In multi-root workspaces this can silently analyze the wrong root.

## Graph Pipeline

Four-stage pipeline in `src/graph/`:

1. **Schema** (`schema.ts`) — Wire-format types: `GraphNode`, `GraphEdge`, `GraphData`, enums. Note: `execution-path` edge type is declared but never emitted (forward-declared). `GraphEdgeProvenance` enum is defined but unused by the resolver (it uses its own local type).
2. **Indexing** (`pythonWorkspaceIndexer.ts`) — Scans `**/*.py` (excludes `.git`, `node_modules`, `.venv`, `venv`, `__pycache__`, `dist` — does NOT exclude `.tox`, `.mypy_cache`, `*.egg-info`, `build/`, `site-packages/`). Parses ASTs synchronously with Lezer on the host thread. Per-file cache keyed by `mtime:size` string; `cache.sweep()` runs after all files are indexed to evict deleted paths.
3. **Resolution** (`pythonRelationResolver.ts`) — Converts indexed symbols into typed edges with confidence scoring. See confidence values below.
4. **Building** (`workspaceGraphBuilder.ts`) — Orchestrates indexing + resolution, computes layer stats. `engineVersion` is hardcoded as `'0.3.0-graph-layers'` and does not track `package.json` version.

`semanticTypes.ts` defines host-only intermediate types (`IndexedModule`, etc.) distinct from the wire-format schema.

### Call Resolution Confidence Ladder

| Confidence | Scenario |
|------------|----------|
| 0.96 | Module alias import-map, unique match |
| 0.93 | Direct symbol import-map, unique match |
| 0.90 | Module alias + dependency boundary filter, unique match |
| 0.86 | Same-module unique candidate |
| 0.72 | Unique candidate in an imported dependency |
| 0.62 | Single global workspace candidate (weakest) |
| 0.00 | Unresolved (multiple candidates or no match) |

Other edge confidences: `class-usage` = 0.65, `dataflow` = 0.70, `dependency` = 0.88.

### Known Resolution Limitations

- `self.foo()` / `cls.foo()`: The resolver does not scope method calls to the containing class. `calleeName` is extracted as `'foo'` and the standard global resolution ladder applies, which may incorrectly resolve to any function named `foo`.
- `dataflow` edges only resolve when exactly one function matches the callee name globally — ambiguous matches are silently dropped.
- Module-level calls (outside any function) use `moduleNodeId` as the source function in call edges.

## Webview Rendering

### Variable Node Filtering

Variable nodes exist in `latestGraphData`, `nodeCatalog`, and `edgeCatalog` but are **filtered out** in `buildCytoscapeElements` (`node.type !== 'variable'`). Inspector lookups still work via catalogs, but `cy.getElementById(variableId)` returns empty. To render variables, remove this filter.

### Edge Display Waterfall

Runs independently in both `buildCytoscapeElements` (rendering) and `resolveFlowEdges` (flow extraction) — changes must be mirrored in both:

1. Prefer `call` or `dependency` edges among visible nodes.
2. Fall back to all non-`contains` edges.
3. Last resort: all edges.

### Flow Extraction

- Roots: nodes with in-degree=0 and out-degree>0. Fallback: any node with outgoing edges (can produce large/redundant flows in cyclic graphs).
- Cycle avoidance is per-path visited set, not global — same node can appear in flows from different roots.
- Capped at 250 flows (silent truncation, not surfaced in UI). Sorted by path length descending, then label.
- Paths shorter than 2 nodes are discarded.

### Graph Lifecycle

The Cytoscape instance is destroyed and recreated on every `graphData` message. All tap handlers are re-attached. Module-level selection state (`selectedNodeId`, `selectedEdgeId`, `selectedFlowId`) persists across renders — stale selections are handled gracefully via `nonempty()` checks.

## Build System

esbuild with two entry points configured in `esbuild.mjs`:
- `src/extension.ts` → `dist/extension.js` (Node/CJS, externals: `vscode`). All deps (`@lezer/*`) are bundled.
- `src/webview/main.ts` → `media/webview.js` (Browser/IIFE). `cytoscape` is bundled.

`dist/` is gitignored. `media/webview.js` is checked in (included in `.vsix`). `vscode:prepublish` runs `check` then `build` — type errors block packaging.
