# FlowDE

FlowDE is a VS Code extension MVP that adds a graph-based cognition layer for Python codebases.

It visualizes:

- Functions as nodes
- Modules as nodes
- Function calls and module dependencies as edges

And it keeps the text-first workflow intact by letting you click a node and jump directly to the exact source line.

## MVP Capabilities

- Command: `FlowDE: Open Graph View`
- Dedicated graph panel in VS Code webview
- Python workspace parsing (`*.py` files)
- Graph rendering with zoom and pan
- Node click navigation to code (file + line)
- Live refresh support (manual and on Python file changes)

## Architecture

### 1. Extension Backend

Location: `src/extension.ts`

Responsibilities:

- Registers the command
- Creates and manages webview panel
- Builds workspace graph via parser service
- Handles navigation events from webview
- Watches Python file changes and refreshes graph

### 2. Parsing + Graph Builder

Location: `src/graph/pythonGraphBuilder.ts`

Responsibilities:

- Scans workspace Python files
- Extracts function definitions and call references
- Extracts import dependencies
- Builds an extensible graph schema (`nodes`, `edges`, `meta`)
- Gracefully accumulates parse warnings instead of crashing

Graph schema: `src/graph/schema.ts`

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
│   │   ├── pythonGraphBuilder.ts
│   │   └── schema.ts
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

## Notes on Parsing Reliability

Python is dynamic, so this MVP parser intentionally prioritizes resilience over perfect precision.

- It tolerates imperfect code by returning partial graphs
- It reports parse issues through warning metadata
- Ambiguous call targets are skipped rather than guessed

This keeps the graph trustworthy and extensible for future improvements.