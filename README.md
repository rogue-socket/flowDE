# FlowDE

FlowDE is a VS Code extension that adds a graph-native cognition layer for Python codebases.

It now visualizes:

- Functions as nodes
- Classes as nodes
- Variables as nodes
- Modules as nodes
- Structural, dependency, and data-flow relations as distinct edge layers

And it keeps the text-first workflow intact by letting you click a node and jump directly to the exact source line.

## Phase 2 Capabilities

- Command: `FlowDE: Open Graph View`
- Dedicated graph panel in VS Code webview
- Python workspace parsing (`*.py` files)
- Graph rendering with zoom and pan
- Layer controls for Structural, Dependency, Data Flow, and Execution (future-ready)
- Node click navigation to code (file + line)
- Live refresh support (manual and on Python file changes)
- Smart reduction + expand-on-demand for dense graphs
- Runtime trace instrumentation with live graph highlighting
- Step-through execution replay controls
- Node runtime state inspection (inputs, outputs, intermediate locals)
- Graph-native editing controls (create/connect/rename/move)
- Bi-directional graph-code sync via direct code edits + file watcher refresh
- Entry-point call path exploration with branching-aware path enumeration
- Data-flow tracing across variables/functions with forward/backward traversal

## Architecture

### 1. Extension Backend

Location: `src/extension.ts`

Responsibilities:

- Registers the command
- Creates and manages webview panel
- Builds workspace graph via parser service
- Handles navigation events from webview
- Watches Python file changes and refreshes graph

### 2. Semantic Graph Engine

Locations:

- `src/graph/pythonWorkspaceIndexer.ts`
- `src/graph/pythonRelationResolver.ts`
- `src/graph/workspaceGraphBuilder.ts`
- `src/graph/workspaceGraphCache.ts`

Pipeline:

1. Indexer: parses Python files into module/class/function/variable/import/call/data-flow artifacts
2. Resolver: resolves cross-file relations with confidence + provenance
3. Builder: assembles layered graph nodes/edges and meta diagnostics

Graph layers:

- Structural layer: containment and declaration topology
- Dependency layer: calls, imports, class usage
- Data flow layer: variable movement and transformation paths
- Execution layer: runtime trace events, traversal replay, and dynamic execution paths

Graph schema: `src/graph/schema.ts`

Core model guarantees:

- Nodes can have multiple roles (`container`, `callable`, `type`, `state`, `transform`, `external`)
- Every edge has an explicit layer and type
- Graph metadata reports per-layer stats and resolution diagnostics

Execution mapping strategy:

- Python runtime tracer emits structured events (call/line/return/exception)
- Extension maps runtime events to static graph nodes by workspace-relative file + symbol + line heuristics
- Webview stores traces for replay and overlays execution traversal on the graph in time order

Graph editing and control strategy:

- Create Function via graph panel: selects module, inputs/outputs, and writes a generated Python stub
- Connect Nodes via graph panel: inserts a function call into the selected source function body
- Rename Node: applies identifier rename across Python files with conflict checks
- Move Function: extracts a top-level function block and appends it to a target module
- Conflict handling: stale mapping, duplicate definitions, invalid identifiers, and unsupported method moves are rejected with explicit error messages

Call path and data flow strategy:

- Call Path Explorer: pick an entry function and enumerate possible transitive call paths with configurable max depth
- Branching visibility: path exploration captures multiple branch outcomes and reports touched branch points
- Data Flow Explorer: pick a source node and trace forward/backward transformation propagation over dataflow (+ call-assisted) edges
- Impact overlays: traced paths and transformations are rendered directly in the graph with live counts in the sidebar

### 3. Webview Frontend

Location: `src/webview/main.ts` + `media/styles.css`

Responsibilities:

- Renders interactive graph with Cytoscape
- Supports click, pan, zoom
- Sends navigation and refresh messages to backend
- Displays graph stats and parse warning count

### 4. Messaging Layer

Bi-directional message types:

- Webview -> Extension:
	- `ready`
	- `refreshGraph`
	- `navigateToNode`
- Extension -> Webview:
	- `graphData`
	- `graphError`

## Project Structure

```text
.
├── .vscode/
│   ├── launch.json
│   └── tasks.json
├── media/
│   └── styles.css
├── src/
│   ├── graph/
│   │   ├── pythonRelationResolver.ts
│   │   ├── pythonWorkspaceIndexer.ts
│   │   ├── schema.ts
│   │   ├── semanticTypes.ts
│   │   ├── workspaceGraphBuilder.ts
│   │   └── workspaceGraphCache.ts
│   ├── webview/
│   │   └── main.ts
│   └── extension.ts
├── .gitignore
├── esbuild.mjs
├── package.json
└── tsconfig.json
```

## Setup

### Prerequisites

- Node.js 20+
- npm 10+
- VS Code

### Install

```bash
npm install
```

### Build

```bash
npm run build
```

### Run Extension

1. Open this repository in VS Code.
2. Press `F5` (launch config: `Run FlowDE Extension`).
3. In the Extension Development Host window, open any Python project folder.
4. Run command: `FlowDE: Open Graph View`.

## Validation Checklist

Functional checks:

- Graph panel opens without crashing
- Functions appear as nodes
- Clicking a function node opens the correct file and line

Edge-case checks:

- Empty project
- Single Python file
- Files with no functions
- Files with syntax errors (graph should partially render)

Performance check:

- Test with 20-50 Python files
- Verify graph loads in a reasonable time on refresh

## Notes on Semantic Reliability

Python is dynamic, so the semantic engine prioritizes traceable confidence over false certainty.

- Every call edge includes provenance (`import-map`, `ast`, `heuristic`) and confidence
- Resolver reports unresolved vs ambiguous calls in graph diagnostics
- Indexer uses incremental cache (file mtime + size) for faster refreshes
- Parser failures degrade gracefully into partial module graphs with warnings

This keeps graph evolution measurable while enabling future LSP/runtime trace enrichment.
