# FlowDE

FlowDE is a VS Code extension for visualizing Python code as a focused flowchart-oriented graph explorer.

The current implementation is intentionally focused on one core workflow:

1. Build a static graph from Python files in the active workspace
2. Discover top-to-bottom directed flows
3. Let the user inspect each flow step-by-step
4. Jump from graph node to source code location

## Current Status

- Scope is intentionally reduced to a minimal flowchart graph viewing experience
- TypeScript strict checks are enabled and pass via `npm run check`
- Bundling is done with esbuild and passes via `npm run build`
- Runtime tracing and graph-to-code mutation features were removed from host and webview

## What You Can Do

- Run command: `FlowDE: Open Graph View`
- See a graph of modules, classes, and functions from workspace Python files
- Auto-refresh graph when `*.py` files are created, edited, or deleted
- Refresh manually from the toolbar
- Toggle layout:
	- Top to Bottom (breadth-first directed)
	- Force Directed (CoSE)
- Fit graph viewport
- Set flow extraction max depth
- Filter flows by module
- Pick a discovered flow and inspect ordered steps
- Select a node and see inspector details:
	- name
	- type
	- incoming edge count
	- outgoing edge count
	- source location (if available)
- Open source for the selected node

## What Is Not Included (By Design)

- Runtime execution tracing and replay
- Execution overlays and timeline controls
- Graph-to-code mutation actions (create/connect/rename/move)
- Advanced explorer panels (journey mode, call-path explorer, data-flow explorer)
- Layer toggles, abstraction toggles, reduction toggles, minimap, and playback controls

## Product Model

FlowDE is a two-part system:

- Extension host (Node, VS Code API)
- Webview UI (browser runtime with Cytoscape)

The host builds graph data from Python sources and sends it to the webview. The webview computes candidate top-to-bottom paths and renders interactions.

## Core Architecture

### Extension Host

File: `src/extension.ts`

Responsibilities:

- Register command `flowde.openGraphView`
- Create and manage one webview panel
- Watch Python files in workspace and schedule debounced refresh
- Build graph via `PythonWorkspaceGraphBuilder`
- Cache node lookup by id for navigation
- Open selected node source location in editor

Incoming webview message types:

- `ready`
- `refreshGraph`
- `navigateToNode`

Outgoing host message types:

- `graphData`
- `graphError`

### Graph Pipeline

Files:

- `src/graph/schema.ts`
- `src/graph/semanticTypes.ts`
- `src/graph/workspaceGraphBuilder.ts`
- `src/graph/pythonWorkspaceIndexer.ts`
- `src/graph/pythonRelationResolver.ts`
- `src/graph/workspaceGraphCache.ts`

Pipeline stages:

1. Index workspace Python files with lezer parser
2. Collect symbols and references:
	 - modules
	 - classes
	 - functions
	 - variables
	 - call references
	 - data-flow references
	 - imports and alias bindings
3. Resolve references into graph edges:
	 - containment edges
	 - call edges
	 - module dependency edges
	 - class usage edges
	 - data-flow edges
4. Compute graph diagnostics and layer stats

Graph cache strategy:

- Cache key: `mtime:size`
- Cache stores per-file indexed module output
- Cache is swept for deleted files

### Webview

Files:

- `src/webview/main.ts`
- `media/styles.css`

Responsibilities:

- Render graph with Cytoscape
- Filter out variable nodes for visual clarity
- Prefer call/dependency edges for flow view (fallback to other edges)
- Discover directed flows with DFS from root candidates
- Enforce max flow depth and max flow count
- Render flow list and step list
- Highlight selected flow and selected node
- Show inspector metadata and enable source navigation

Flow extraction behavior:

- Root candidates are nodes with zero in-degree and non-zero out-degree
- If no roots exist, any node with outgoing edges is used as fallback start
- DFS avoids cycles by per-path visited set
- Paths shorter than 2 nodes are discarded
- Result set is deduplicated by node-id sequence key
- Result count capped at 250 flows

## File Structure

```
.
|-- .vscode/
|   |-- launch.json
|   `-- tasks.json
|-- CHANGELOG.md
|-- LICENSE
|-- README.md
|-- esbuild.mjs
|-- media/
|   |-- icon.png
|   |-- styles.css
|   |-- webview.js
|   `-- webview.js.map
|-- package.json
|-- src/
|   |-- extension.ts
|   |-- graph/
|   |   |-- pythonRelationResolver.ts
|   |   |-- pythonWorkspaceIndexer.ts
|   |   |-- schema.ts
|   |   |-- semanticTypes.ts
|   |   |-- workspaceGraphBuilder.ts
|   |   `-- workspaceGraphCache.ts
|   `-- webview/
|       `-- main.ts
`-- tsconfig.json
```

Notes:

- `media/webview.js` and `.map` are build outputs generated from `src/webview/main.ts`
- `dist/extension.js` is generated from `src/extension.ts`

## Setup

### Prerequisites

- Node.js 20+
- npm 10+
- VS Code 1.95+

### Install dependencies

```bash
npm install
```

### Build extension + webview bundles

```bash
npm run build
```

### Watch mode

```bash
npm run watch
```

### Type check

```bash
npm run check
```

### Run in Extension Development Host

1. Open this repository in VS Code
2. Press `F5` and choose `Run FlowDE Extension`
3. In the new Extension Development Host, open a Python workspace
4. Execute command `FlowDE: Open Graph View`

## Build and Packaging

Available scripts from `package.json`:

- `build`: esbuild extension and webview
- `watch`: esbuild watch for both targets
- `check`: TypeScript no-emit compile
- `vscode:prepublish`: runs `check` and `build` before packaging/publish
- `package`: package VSIX using vsce
- `publish`: publish using vsce

Recommended release flow:

1. `npm run check`
2. `npm run build`
3. `npm run package`
4. Validate the generated `.vsix` locally in VS Code
5. `npm run publish`

Notes:

- Build outputs in `dist/` and `media/webview.js` are generated artifacts and are gitignored
- VSIX files are generated artifacts and are gitignored

## Marketplace Publisher

- VS Code Marketplace publisher id: `rogue-socket`
- Ensure your publishing token has access to this publisher before running `npm run publish`

## Dependencies

Runtime:

- `@lezer/common`
- `@lezer/python`
- `cytoscape`

Development:

- `typescript`
- `esbuild`
- `@types/node`
- `@types/vscode`
- `@vscode/vsce`

## Simplification Notes (What Changed)

The current codebase reflects a simplification pass to keep FlowDE focused and maintainable.

Removed from implementation:

- runtime trace orchestration in extension host
- Python tracer runtime module
- graph edit operations from webview and host message channel
- advanced analysis and navigation control panels

Retained:

- graph indexing/resolution engine
- focused graph rendering and flow exploration
- node-to-source navigation

## Known Constraints

- Call resolution is heuristic and may leave ambiguous calls unresolved
- Flow extraction is static and based on directed graph topology, not runtime behavior
- Very large Python workspaces may produce dense graphs despite UI simplification
- Variable symbols are still indexed for graph semantics, but hidden from the main graph UI for readability

## Documentation

- Product requirements and implementation specification: `docs/PRD.md`

