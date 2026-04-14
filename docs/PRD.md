# FlowDE Product Requirements Document

## 1. Document Control

- Product: FlowDE
- Product type: VS Code extension
- Domain: Python static flowchart visualization
- Current baseline: v0.1.0 codebase with simplified flowchart-first experience
- Primary source repository: flowDE

## 2. Executive Summary

FlowDE provides a graph-native way to inspect Python code structure and directional flow in VS Code. The current implementation is intentionally minimal and centered on static workspace analysis and top-to-bottom flow exploration.

The product goal is to help developers quickly answer:

- What are the major directed paths in this codebase?
- Which nodes are part of each path?
- Where in source should I jump next?

The product explicitly avoids runtime tracing and code mutation features in its current scope.

## 3. Product Vision and Ideation

### 3.1 Vision

Create a fast, low-friction flowchart interface for Python workspaces that complements text-first development in VS Code.

### 3.2 Ideation Principles

- Keep UI simple and focused on one job
- Show major directional paths without overwhelming controls
- Keep navigation to source code immediate and reliable
- Prefer deterministic static analysis over opaque heuristics where possible
- Maintain strict typing and clear architecture boundaries

### 3.3 Value Proposition

- Faster system understanding for unfamiliar Python repositories
- Clear visual path discovery for onboarding and debugging
- Tight editor integration through direct node-to-source navigation

## 4. Goals, Non-Goals, and Scope

### 4.1 In-Scope Goals (Current)

- Build graph model from Python files in active workspace
- Render nodes and edges in webview with responsive controls
- Discover and list top-to-bottom directed flows
- Filter flows by max depth and module scope
- Show selected flow steps in order
- Open selected node source line in editor
- Refresh graph automatically and manually

### 4.2 Out-of-Scope (Current)

- Runtime execution trace ingestion and replay
- Graph-driven code mutation (create/connect/rename/move)
- Multi-user collaboration
- Remote graph persistence or synchronization
- Full language-agnostic support beyond Python

### 4.3 Future Candidate Scope

- Optional advanced overlays as toggled modules
- Performance optimizations for large monorepos
- Better confidence scoring and ambiguity explanations
- Test coverage expansion for indexing/resolution and flow extraction

## 5. User Personas

### 5.1 Primary Persona

- Python developer using VS Code
- Needs rapid high-level understanding of code relationships
- Prefers visual map plus direct source navigation

### 5.2 Secondary Persona

- Tech lead or reviewer analyzing unfamiliar module flow
- Needs a quick directional map before deep code review

## 6. User Stories

- As a developer, I want to open a graph view for my workspace so I can inspect major code paths
- As a developer, I want to select a flow and see each step so I can follow the sequence
- As a developer, I want to click a node and open its source location so I can continue in code immediately
- As a developer, I want depth and module filters so I can narrow signal from noise
- As a developer, I want updates when Python files change so the graph stays relevant

## 7. Functional Requirements

### FR-001 Command Registration

- System shall register command `flowde.openGraphView`
- Command shall open or reveal a single graph webview panel

### FR-002 Workspace Requirement

- System shall require an open workspace folder
- If missing, system shall show warning and avoid panel creation

### FR-003 Webview Initialization

- Webview shall send `ready` message after boot
- Host shall respond by building and posting graph data

### FR-004 Manual Refresh

- Webview shall expose refresh action
- Action shall send `refreshGraph` to host
- Host shall rebuild graph and post latest payload

### FR-005 Auto Refresh

- Host shall watch `**/*.py` in workspace
- Host shall debounce refresh calls
- Host shall refresh on create, change, delete events

### FR-006 Graph Build Pipeline

- Host shall invoke builder to produce `GraphData`
- Builder shall combine indexer output with resolver output
- Builder shall compute per-layer stats and diagnostics metadata

### FR-007 Graph Rendering

- Webview shall render graph using Cytoscape
- Webview shall render module/class/function nodes
- Webview shall filter out variable nodes from visible graph

### FR-008 Edge Selection Strategy for Flow UI

- Webview shall prefer call and dependency edges when present
- If none exist, webview shall fallback to non-contains edges
- If fallback still empty, webview shall use all available edges among visible nodes

### FR-009 Layout Control

- Webview shall support two layouts:
  - Top to Bottom (breadth-first, directed)
  - Force Directed (CoSE)

### FR-010 Flow Extraction

- Webview shall extract directed flows via DFS
- Roots shall be nodes with in-degree 0 and out-degree > 0
- If no roots, fallback roots shall be nodes with out-degree > 0
- DFS shall avoid cycles using visited-set per path
- Paths with fewer than 2 nodes shall be ignored
- Flows shall be deduplicated by path signature
- Max flows shall be capped (250)
- Depth shall be bounded by user max-depth control

### FR-011 Flow Filtering

- Webview shall filter flows by module selection
- Module filter shall include all modules plus `all`

### FR-012 Flow and Step Presentation

- Webview shall render flow list with stable labels
- Selecting a flow shall render ordered step list
- Selecting a step shall center graph on node

### FR-013 Highlighting

- Webview shall dim non-flow nodes/edges when a flow is selected
- Webview shall highlight selected flow nodes/edges
- Webview shall highlight selected node independently

### FR-014 Node Inspector

- Webview shall show selected node details:
  - name
  - type
  - incoming edge count
  - outgoing edge count
  - source location (path:line or N/A)

### FR-015 Source Navigation

- Webview open-source action shall send `navigateToNode`
- Host shall open file and reveal line for node with valid filePath and line

### FR-016 Error Reporting

- Host shall send `graphError` on graph build failure
- Webview shall display status error text

### FR-017 Single Panel Lifecycle

- System shall maintain one panel reference
- Reinvoking command shall reveal existing panel
- Dispose shall release subscriptions and timers safely

## 8. Non-Functional Requirements

### NFR-001 Performance

- Graph refresh should complete fast enough for interactive use on small to medium repositories
- Debouncing must prevent redundant refresh storms on rapid file saves

### NFR-002 Reliability

- Indexer must degrade gracefully via fallback module on parse failure
- Webview should remain responsive even with empty graph or no flows

### NFR-003 Maintainability

- Strict TypeScript compile settings enabled
- Clear separation between host, graph engine, and webview layers

### NFR-004 Security

- Webview CSP must deny default sources
- Scripts must use nonce and local resource roots only

### NFR-005 Compatibility

- VS Code engine target: ^1.95.0
- Node target for extension bundle: node20
- Browser target for webview bundle: es2020

## 9. System Architecture

## 9.1 High-Level Components

- Extension Host
- Graph Builder
- Python Workspace Indexer
- Relation Resolver
- In-memory Cache
- Webview Controller
- Graph Renderer (Cytoscape)

### 9.2 Data Flow

1. Webview sends `ready` or `refreshGraph`
2. Host resolves workspace and calls builder
3. Builder indexes workspace and resolves relations
4. Host posts `graphData` to webview
5. Webview renders graph and derives directed flows
6. User selects node/flow/step
7. Webview optionally sends `navigateToNode`
8. Host opens source location

## 10. Data Contracts and Schemas

### 10.1 Graph Node

- id
- type: function | variable | module | class
- name
- layers
- roles
- optional filePath, line, moduleName, metadata

### 10.2 Graph Edge

- id
- source
- target
- type: call | dependency | contains | class-usage | dataflow | execution-path
- layer
- optional metadata (confidence, provenance, reason)

### 10.3 Graph Meta

- workspaceName
- generatedAt
- fileCount
- engineVersion
- layerStats
- diagnostics
- parseWarnings

### 10.4 Host/Webview Messaging

Webview to Host:

- ready
- refreshGraph
- navigateToNode

Host to Webview:

- graphData
- graphError

## 11. Implementation Details by File

### 11.1 Root Configuration and Build

- `package.json`
  - extension metadata
  - command contribution
  - npm scripts
  - dependencies and devDependencies
- `tsconfig.json`
  - strict compile options
  - target/module settings
- `esbuild.mjs`
  - bundles extension host to `dist/extension.js`
  - bundles webview to `media/webview.js`
  - supports watch mode for both bundles

### 11.2 Extension Host Layer

- `src/extension.ts`
  - activation/deactivation
  - command registration
  - panel lifecycle
  - file watcher + refresh debounce
  - graph build execution
  - node id map for navigation
  - source reveal behavior

### 11.3 Graph Domain Layer

- `src/graph/schema.ts`
  - shared graph interfaces and enums
- `src/graph/semanticTypes.ts`
  - indexing and resolution intermediate contracts
- `src/graph/workspaceGraphCache.ts`
  - in-memory versioned module cache
- `src/graph/pythonWorkspaceIndexer.ts`
  - file discovery
  - parser-based symbol/reference extraction
  - import artifact extraction and relative import resolution
  - data-flow references from assignment, parameters, returns
  - fallback behavior on parse errors
- `src/graph/pythonRelationResolver.ts`
  - constructs graph nodes and structural edges
  - resolves call targets using import-map and scoped heuristics
  - emits dependency, class-usage, and dataflow edges
  - computes resolution diagnostics
- `src/graph/workspaceGraphBuilder.ts`
  - orchestrates indexer + resolver
  - composes graph metadata and layer stats

### 11.4 Webview Layer

- `src/webview/main.ts`
  - message bridge
  - graph render and style setup
  - layout switching
  - module filter + depth controls
  - DFS-based flow extraction
  - flow/step rendering
  - highlighting and node inspector
  - open-source interaction
- `media/styles.css`
  - responsive split layout
  - toolbar/sidebar/graph styling
  - flow list and inspector styles
- `media/icon.png`
  - extension icon

### 11.5 VS Code Launch and Tasks

- `.vscode/launch.json`
  - extension host launch configuration with preLaunch build task
- `.vscode/tasks.json`
  - npm build and watch tasks

## 12. Current Repository Structure (Implementation-Relevant)

```
.
|-- .vscode/
|   |-- launch.json
|   `-- tasks.json
|-- CHANGELOG.md
|-- LICENSE
|-- README.md
|-- docs/
|   `-- PRD.md
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

Generated artifacts:

- `dist/extension.js`
- `media/webview.js`
- source maps for both

## 13. Requirements Traceability to Current Features

- FR-001..FR-005: implemented in host panel and watcher lifecycle
- FR-006..FR-008: implemented through builder/indexer/resolver and webview edge strategy
- FR-009..FR-013: implemented in webview controls and style-class overlays
- FR-014..FR-015: implemented in inspector and navigate-to-node flow
- FR-016..FR-017: implemented in message error handling and panel lifecycle guards

## 14. Setup and Operations Requirements

### 14.1 Local Setup Requirements

- Node.js 20+
- npm 10+
- VS Code 1.95+

### 14.2 Build Requirements

- `npm install` must succeed
- `npm run check` must pass
- `npm run build` must pass

### 14.3 Dev Run Requirements

- F5 launch profile must run with preLaunch build
- extension host window must open
- command `FlowDE: Open Graph View` must be available

## 15. Acceptance Criteria

### AC-001 Graph Open

- Given a workspace exists
- When user runs open command
- Then graph panel opens without errors

### AC-002 Graph Refresh

- Given panel is open
- When user edits a Python file
- Then graph updates automatically after debounce

### AC-003 Flow Discovery

- Given graph has directed edges
- When user adjusts max depth/module filter
- Then flow list updates and remains interactive

### AC-004 Step Navigation

- Given flow is selected
- When user clicks a step
- Then node is selected and centered in graph

### AC-005 Source Navigation

- Given selected node has filePath and line
- When user clicks Open source
- Then editor opens file and reveals exact line

### AC-006 Error Handling

- Given graph build failure occurs
- When error is raised in host
- Then webview displays error status text

## 16. Testing Strategy

### 16.1 Current Validation Baseline

- Manual exploratory testing in extension development host
- Compile gate via strict TypeScript check
- Build gate via esbuild bundling

### 16.2 Recommended Test Additions

- Unit tests for flow extraction logic in webview controller
- Unit tests for import and call resolution heuristics
- Integration tests for host-webview message contract
- Regression tests for parser fallback behavior

## 17. Change Summary (Recent Simplification)

### 17.1 Removed Capabilities

- Runtime tracing lifecycle and subprocess orchestration
- Runtime event mapping and execution overlays
- Graph-to-code mutation operations from UI and host
- Advanced control surfaces beyond core flow workflow

### 17.2 Retained Capabilities

- Static analysis graph engine
- Directed flow derivation in webview
- Node-to-source navigation
- Build and packaging pipeline

### 17.3 Rationale

- Reduce redundancy and cognitive overhead
- Improve maintainability and product clarity
- Keep one strong core workflow before reintroducing optional complexity

## 18. Constraints and Risks

### 18.1 Constraints

- Python static analysis cannot guarantee runtime call truth in dynamic patterns
- Large repositories can still produce dense graphs
- Current project has no automated test suite gate

### 18.2 Risks

- Ambiguous call targets can reduce flow precision
- Dense dependency graphs can reduce readability in one screen

### 18.3 Mitigations

- Confidence and provenance metadata retained in graph model
- Module/depth flow filters reduce visible complexity
- Strict compile checks reduce accidental regressions

## 19. Requirements for Future Iterations

- Modular feature flags for optional advanced panels
- Performance tuning for large workspace indexing
- Better surfaced diagnostics in webview status area
- Structured test suite for graph engine and flow extraction

## 20. Setup Quick Commands

```bash
npm install
npm run check
npm run build
npm run watch
```

Run extension in VS Code:

1. Open repository
2. Press F5 (Run FlowDE Extension)
3. In extension host window, open Python workspace
4. Run FlowDE: Open Graph View
