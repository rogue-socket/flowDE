import cytoscape = require('cytoscape');

declare function acquireVsCodeApi(): {
  postMessage: (message: unknown) => void;
};

type GraphLayer = 'structural' | 'dependency' | 'dataflow' | 'execution';
type GraphNodeType = 'function' | 'variable' | 'module' | 'class';
type GraphEdgeType =
  | 'call'
  | 'dependency'
  | 'contains'
  | 'class-usage'
  | 'dataflow'
  | 'execution-path';

interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  layers: GraphLayer[];
  roles: string[];
  filePath?: string;
  line?: number;
  metadata?: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  layer: GraphLayer;
  metadata?: {
    confidence?: number;
    provenance?: string;
    reason?: string;
    [key: string]: unknown;
  };
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: {
    workspaceName: string;
    generatedAt: string;
    fileCount: number;
    engineVersion: string;
    layerStats: Record<GraphLayer, { nodes: number; edges: number; visibleByDefault: boolean }>;
    diagnostics: {
      resolvedCalls: number;
      unresolvedCalls: number;
      ambiguousCalls: number;
      classUsageEdges: number;
      dataFlowEdges: number;
      indexedClasses: number;
      indexedVariables: number;
      parserCacheHits: number;
      parserCacheMisses: number;
    };
    parseWarnings: string[];
  };
}

type IncomingMessage =
  | { type: 'graphData'; payload: GraphData }
  | { type: 'graphError'; message: string }
  | { type: 'graphEditResult'; ok: boolean; message: string }
  | { type: 'executionReset'; entryFilePath: string }
  | { type: 'executionEvent'; payload: ExecutionTraceEvent }
  | { type: 'executionComplete'; summary: { totalEvents: number; exitCode?: number; stopped?: boolean } }
  | { type: 'executionError'; message: string };

type ExecutionEventType = 'call' | 'line' | 'return' | 'exception';

interface ExecutionTraceEvent {
  index: number;
  eventType: ExecutionEventType;
  timestamp: number;
  filePath: string;
  line: number;
  definitionLine?: number;
  functionName: string;
  qualifiedName?: string;
  nodeId?: string;
  inputs?: Record<string, unknown>;
  locals?: Record<string, unknown>;
  output?: unknown;
  exception?: string;
}

type LayoutMode = 'clustered' | 'force';

interface Point {
  x: number;
  y: number;
}

interface FlowDefinition {
  id: string;
  name: string;
  nodeIds: string[];
  edgeIds: string[];
}

interface FlowFilters {
  minSteps: number;
  minConfidence: number;
  moduleId: string;
}

interface FocusFilters {
  moduleNodeId: string;
  neighborhoodOnly: boolean;
}

type DependencyDirection = 'upstream' | 'downstream' | 'both';

interface DependencyTraversalState {
  direction: DependencyDirection;
  maxHops: number;
}

interface DependencyAnalysisSnapshot {
  upstreamNodeIds: Set<string>;
  downstreamNodeIds: Set<string>;
  upstreamEdgeIds: Set<string>;
  downstreamEdgeIds: Set<string>;
  blastRadiusNodeCount: number;
}

interface CallPathExplorerState {
  enabled: boolean;
  entryNodeId: string;
  maxDepth: number;
}

type DataFlowDirection = 'forward' | 'backward' | 'both';

interface DataFlowExplorerState {
  enabled: boolean;
  sourceNodeId: string;
  direction: DataFlowDirection;
  maxHops: number;
}

interface DataFlowAnalysisSnapshot {
  sourceNodeId: string;
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  forwardCount: number;
  backwardCount: number;
  transformationCount: number;
}

interface ReductionState {
  collapseInternalFunctions: boolean;
  collapseLibraries: boolean;
  expandedModuleIds: Set<string>;
  librariesExpanded: boolean;
}

interface LayerVisibility {
  structural: boolean;
  dependency: boolean;
  dataflow: boolean;
  execution: boolean;
}

interface MinimapTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

const vscode = acquireVsCodeApi();
const graphContainer = getRequiredElement<HTMLElement>('#graph-canvas');
const minimapCanvas = getRequiredElement<HTMLCanvasElement>('#minimap-canvas');
const minimapContext = getRequiredCanvasContext(minimapCanvas);
const statusText = getRequiredElement<HTMLElement>('#status');
const flowMeta = getRequiredElement<HTMLElement>('#flow-meta');
const focusFile = getRequiredElement<HTMLSelectElement>('#focus-file');
const focusNeighborhood = getRequiredElement<HTMLInputElement>('#focus-neighborhood');
const dependencyDirection = getRequiredElement<HTMLSelectElement>('#dependency-direction');
const dependencyHops = getRequiredElement<HTMLInputElement>('#dependency-hops');
const dependencyHopsValue = getRequiredElement<HTMLElement>('#dependency-hops-value');
const dependencyStatus = getRequiredElement<HTMLElement>('#dependency-status');
const callPathEntry = getRequiredElement<HTMLSelectElement>('#callpath-entry');
const callPathDepth = getRequiredElement<HTMLInputElement>('#callpath-depth');
const callPathDepthValue = getRequiredElement<HTMLElement>('#callpath-depth-value');
const callPathRunButton = getRequiredElement<HTMLButtonElement>('#callpath-run-btn');
const callPathClearButton = getRequiredElement<HTMLButtonElement>('#callpath-clear-btn');
const callPathStatus = getRequiredElement<HTMLElement>('#callpath-status');
const dataFlowSource = getRequiredElement<HTMLSelectElement>('#dataflow-source');
const dataFlowDirection = getRequiredElement<HTMLSelectElement>('#dataflow-direction');
const dataFlowHops = getRequiredElement<HTMLInputElement>('#dataflow-hops');
const dataFlowHopsValue = getRequiredElement<HTMLElement>('#dataflow-hops-value');
const dataFlowRunButton = getRequiredElement<HTMLButtonElement>('#dataflow-run-btn');
const dataFlowClearButton = getRequiredElement<HTMLButtonElement>('#dataflow-clear-btn');
const dataFlowStatus = getRequiredElement<HTMLElement>('#dataflow-status');
const focusClearButton = getRequiredElement<HTMLButtonElement>('#focus-clear-btn');
const layerStructuralToggle = getRequiredElement<HTMLInputElement>('#layer-structural');
const layerDependencyToggle = getRequiredElement<HTMLInputElement>('#layer-dependency');
const layerDataFlowToggle = getRequiredElement<HTMLInputElement>('#layer-dataflow');
const layerExecutionToggle = getRequiredElement<HTMLInputElement>('#layer-execution');
const collapseFunctionsToggle = getRequiredElement<HTMLInputElement>('#collapse-functions');
const collapseLibrariesToggle = getRequiredElement<HTMLInputElement>('#collapse-libraries');
const reductionHint = getRequiredElement<HTMLElement>('#reduction-hint');
const executionStartButton = getRequiredElement<HTMLButtonElement>('#execution-start-btn');
const executionStopButton = getRequiredElement<HTMLButtonElement>('#execution-stop-btn');
const executionPrevButton = getRequiredElement<HTMLButtonElement>('#execution-prev-btn');
const executionPlayButton = getRequiredElement<HTMLButtonElement>('#execution-play-btn');
const executionNextButton = getRequiredElement<HTMLButtonElement>('#execution-next-btn');
const executionStatus = getRequiredElement<HTMLElement>('#execution-status');
const executionNodeState = getRequiredElement<HTMLElement>('#execution-node-state');
const editCreateModule = getRequiredElement<HTMLSelectElement>('#edit-create-module');
const editCreateName = getRequiredElement<HTMLInputElement>('#edit-create-name');
const editCreateInputs = getRequiredElement<HTMLInputElement>('#edit-create-inputs');
const editCreateOutputs = getRequiredElement<HTMLInputElement>('#edit-create-outputs');
const editCreateButton = getRequiredElement<HTMLButtonElement>('#edit-create-btn');
const editConnectSource = getRequiredElement<HTMLSelectElement>('#edit-connect-source');
const editConnectTarget = getRequiredElement<HTMLSelectElement>('#edit-connect-target');
const editConnectButton = getRequiredElement<HTMLButtonElement>('#edit-connect-btn');
const editRenameName = getRequiredElement<HTMLInputElement>('#edit-rename-name');
const editRenameButton = getRequiredElement<HTMLButtonElement>('#edit-rename-btn');
const editMoveModule = getRequiredElement<HTMLSelectElement>('#edit-move-module');
const editMoveButton = getRequiredElement<HTMLButtonElement>('#edit-move-btn');
const graphEditStatus = getRequiredElement<HTMLElement>('#graph-edit-status');
const nodeInspector = getRequiredElement<HTMLElement>('#node-inspector');
const openSourceButton = getRequiredElement<HTMLButtonElement>('#open-source-btn');
const flowMinLength = getRequiredElement<HTMLSelectElement>('#flow-min-length');
const flowConfidence = getRequiredElement<HTMLInputElement>('#flow-confidence');
const flowConfidenceValue = getRequiredElement<HTMLElement>('#flow-confidence-value');
const flowModule = getRequiredElement<HTMLSelectElement>('#flow-module');
const flowClearButton = getRequiredElement<HTMLButtonElement>('#flow-clear-btn');
const flowList = getRequiredElement<HTMLUListElement>('#flow-list');
const flowSteps = getRequiredElement<HTMLOListElement>('#flow-steps');
const flowPrevButton = getRequiredElement<HTMLButtonElement>('#flow-prev-btn');
const flowPlayButton = getRequiredElement<HTMLButtonElement>('#flow-play-btn');
const flowNextButton = getRequiredElement<HTMLButtonElement>('#flow-next-btn');
const flowExplain = getRequiredElement<HTMLElement>('#flow-explain');
const layoutButton = getRequiredElement<HTMLButtonElement>('#layout-btn');
const fitButton = getRequiredElement<HTMLButtonElement>('#fit-btn');
const zoomOutButton = getRequiredElement<HTMLButtonElement>('#zoom-out-btn');
const zoomResetButton = getRequiredElement<HTMLButtonElement>('#zoom-reset-btn');
const zoomInButton = getRequiredElement<HTMLButtonElement>('#zoom-in-btn');
const refreshButton = getRequiredElement<HTMLButtonElement>('#refresh-btn');
let currentLayoutMode: LayoutMode = 'clustered';
let latestGraphData: GraphData | undefined;
let latestDisplayedGraphData: GraphData | undefined;
let hasInitializedViewport = false;
let minimapUpdateRequested = false;
let minimapTransform: MinimapTransform | undefined;
let flowDefinitions: FlowDefinition[] = [];
let selectedFlowId: string | undefined;
let selectedStepIndex: number | undefined;
let selectedNodeId: string | undefined;
let playbackTimer: number | undefined;
let isPlaybackRunning = false;
let executionPlaybackTimer: number | undefined;
let isExecutionPlaybackRunning = false;
let executionTraceRunning = false;
let executionCursor = -1;
const executionEvents: ExecutionTraceEvent[] = [];
const dynamicExecutionEdgeIds = new Set<string>();
const latestExecutionEventByNodeId = new Map<string, ExecutionTraceEvent>();
const nodeCatalog = new Map<string, GraphNode>();
const callEdgeByPair = new Map<string, string>();
const anyEdgeByPair = new Map<string, string>();
const edgeCatalog = new Map<string, GraphEdge>();

const flowFilters: FlowFilters = {
  minSteps: Number.parseInt(flowMinLength.value, 10) || 2,
  minConfidence: Number.parseInt(flowConfidence.value, 10) / 100 || 0,
  moduleId: 'all'
};

const focusFilters: FocusFilters = {
  moduleNodeId: 'all',
  neighborhoodOnly: false
};

const dependencyTraversal: DependencyTraversalState = {
  direction: (dependencyDirection.value as DependencyDirection) || 'both',
  maxHops: Number.parseInt(dependencyHops.value, 10) || 3
};

let latestDependencyAnalysis: DependencyAnalysisSnapshot | undefined;
const callPathExplorer: CallPathExplorerState = {
  enabled: false,
  entryNodeId: '',
  maxDepth: Number.parseInt(callPathDepth.value, 10) || 8
};

const dataFlowExplorer: DataFlowExplorerState = {
  enabled: false,
  sourceNodeId: '',
  direction: (dataFlowDirection.value as DataFlowDirection) || 'forward',
  maxHops: Number.parseInt(dataFlowHops.value, 10) || 4
};

let latestDataFlowAnalysis: DataFlowAnalysisSnapshot | undefined;

const reductionState: ReductionState = {
  collapseInternalFunctions: collapseFunctionsToggle.checked,
  collapseLibraries: collapseLibrariesToggle.checked,
  expandedModuleIds: new Set<string>(),
  librariesExpanded: false
};

const layerVisibility: LayerVisibility = {
  structural: layerStructuralToggle.checked,
  dependency: layerDependencyToggle.checked,
  dataflow: layerDataFlowToggle.checked,
  execution: layerExecutionToggle.checked
};

const COLLAPSED_LIBRARIES_NODE_ID = 'module:external:collapsed';

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.4;

const graph = cytoscape({
  container: graphContainer,
  elements: [],
  minZoom: MIN_ZOOM,
  maxZoom: MAX_ZOOM,
  userZoomingEnabled: true,
  userPanningEnabled: true,
  layout: {
    name: 'grid'
  },
  wheelSensitivity: 0.07,
  style: [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'font-size': 11,
        color: '#f6f7f8',
        'text-wrap': 'wrap',
        'text-max-width': '150px',
        'background-color': '#3a5a40',
        'text-valign': 'center',
        'text-halign': 'center',
        width: 'label',
        height: 'label',
        padding: '16px',
        'border-width': 1,
        'border-color': '#a3b18a'
      }
    },
    {
      selector: 'node.dimmed',
      style: {
        opacity: 0.16,
        'text-opacity': 0.2
      }
    },
    {
      selector: 'node.flow-node',
      style: {
        opacity: 1,
        'text-opacity': 1,
        'border-width': 2,
        'border-color': '#7ae582'
      }
    },
    {
      selector: 'node.flow-current',
      style: {
        'border-width': 3,
        'border-color': '#f4a261'
      }
    },
    {
      selector: 'node[reductionCollapsed = 1]',
      style: {
        'border-style': 'dashed',
        'border-width': 2,
        'border-color': '#9cbf7c'
      }
    },
    {
      selector: 'node.node-selected',
      style: {
        'border-width': 3,
        'border-color': '#57cc99',
        'text-opacity': 1,
        opacity: 1
      }
    },
    {
      selector: 'node.node-incoming',
      style: {
        'border-width': 2,
        'border-color': '#4cc9f0',
        opacity: 1,
        'text-opacity': 1
      }
    },
    {
      selector: 'node.node-outgoing',
      style: {
        'border-width': 2,
        'border-color': '#f4a261',
        opacity: 1,
        'text-opacity': 1
      }
    },
    {
      selector: 'node.node-impact',
      style: {
        'border-width': 3,
        'border-color': '#ff4d6d',
        opacity: 1,
        'text-opacity': 1
      }
    },
    {
      selector: 'node.node-dataflow',
      style: {
        'border-width': 3,
        'border-color': '#80ed99',
        opacity: 1,
        'text-opacity': 1
      }
    },
    {
      selector: 'node.execution-visited',
      style: {
        'border-width': 2,
        'border-color': '#f94144',
        opacity: 1,
        'text-opacity': 1
      }
    },
    {
      selector: 'node.execution-active',
      style: {
        'border-width': 4,
        'border-color': '#ff9f1c',
        'overlay-color': '#ff9f1c',
        'overlay-opacity': 0.12
      }
    },
    {
      selector: 'node[type = "function"]',
      style: {
        shape: 'roundrectangle',
        'background-color': '#4f772d',
        'border-color': '#cfe1b9'
      }
    },
    {
      selector: 'node[type = "module"]',
      style: {
        shape: 'ellipse',
        'background-color': '#1b4332',
        'border-color': '#95d5b2'
      }
    },
    {
      selector: 'node[type = "class"]',
      style: {
        shape: 'round-hexagon',
        'background-color': '#264653',
        'border-color': '#8ecae6'
      }
    },
    {
      selector: 'node[type = "variable"]',
      style: {
        shape: 'rectangle',
        'background-color': '#606c38',
        'border-color': '#ccd5ae'
      }
    },
    {
      selector: 'node[external = 1]',
      style: {
        'background-color': '#6c757d',
        'border-color': '#ced4da'
      }
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': '#a8b0b8',
        'curve-style': 'unbundled-bezier',
        'target-arrow-shape': 'triangle',
        'target-arrow-color': '#a8b0b8',
        'arrow-scale': 0.7,
        opacity: 0.75
      }
    },
    {
      selector: 'edge.dimmed',
      style: {
        opacity: 0.06
      }
    },
    {
      selector: 'edge.flow-edge',
      style: {
        width: 2.4,
        opacity: 0.95,
        'line-color': '#f4a261',
        'target-arrow-color': '#f4a261'
      }
    },
    {
      selector: 'edge.flow-current-edge',
      style: {
        width: 3.3,
        opacity: 1,
        'line-color': '#ffd166',
        'target-arrow-color': '#ffd166'
      }
    },
    {
      selector: 'edge.edge-incoming',
      style: {
        width: 2.8,
        opacity: 1,
        'line-color': '#4cc9f0',
        'target-arrow-color': '#4cc9f0'
      }
    },
    {
      selector: 'edge.edge-outgoing',
      style: {
        width: 2.8,
        opacity: 1,
        'line-color': '#f4a261',
        'target-arrow-color': '#f4a261'
      }
    },
    {
      selector: 'edge.edge-impact',
      style: {
        width: 3,
        opacity: 1,
        'line-color': '#ff4d6d',
        'target-arrow-color': '#ff4d6d'
      }
    },
    {
      selector: 'edge.edge-dataflow',
      style: {
        width: 2.9,
        opacity: 1,
        'line-color': '#80ed99',
        'target-arrow-color': '#80ed99'
      }
    },
    {
      selector: 'edge.execution-traversed',
      style: {
        width: 3.1,
        opacity: 1,
        'line-color': '#f94144',
        'target-arrow-color': '#f94144'
      }
    },
    {
      selector: 'edge[type = "call"]',
      style: {
        'line-color': '#f4a261',
        'target-arrow-color': '#f4a261'
      }
    },
    {
      selector: 'edge[type = "dependency"]',
      style: {
        'line-style': 'dashed',
        'line-color': '#84a59d',
        'target-arrow-color': '#84a59d'
      }
    },
    {
      selector: 'edge[type = "class-usage"]',
      style: {
        width: 1.8,
        'line-style': 'dotted',
        'line-color': '#5dade2',
        'target-arrow-color': '#5dade2'
      }
    },
    {
      selector: 'edge[type = "dataflow"]',
      style: {
        width: 1.8,
        'line-style': 'solid',
        'line-color': '#90be6d',
        'target-arrow-color': '#90be6d'
      }
    },
    {
      selector: 'edge[type = "execution-path"]',
      style: {
        width: 2.2,
        'line-style': 'dashed',
        'line-color': '#f94144',
        'target-arrow-color': '#f94144'
      }
    },
    {
      selector: 'edge[type = "contains"]',
      style: {
        width: 1,
        'line-style': 'solid',
        'line-color': '#52796f',
        'target-arrow-shape': 'none',
        opacity: 0.22
      }
    }
  ]
});

graph.on('tap', 'node', (event: cytoscape.EventObject) => {
  const node = event.target;
  const nodeId = node.id();
  selectedNodeId = nodeId;
  const selectedNode = nodeCatalog.get(nodeId);
  if (selectedNode) {
    editRenameName.value = selectedNode.name;
    if (selectedNode.type === 'function') {
      editConnectSource.value = selectedNode.id;
      callPathEntry.value = selectedNode.id;
      callPathExplorer.entryNodeId = selectedNode.id;
      graphEditStatus.textContent = `Selected function ${selectedNode.name} for editing.`;
    } else {
      graphEditStatus.textContent = `Selected ${selectedNode.type} ${selectedNode.name}.`;
    }

    if (selectedNode.layers.includes('dataflow')) {
      dataFlowSource.value = selectedNode.id;
      dataFlowExplorer.sourceNodeId = selectedNode.id;
    }
  }

  const activeFlow = getSelectedFlow();
  if (activeFlow) {
    const stepIndex = activeFlow.nodeIds.indexOf(nodeId);
    if (stepIndex >= 0) {
      selectedStepIndex = stepIndex;
      renderFlowSteps(activeFlow);
    }
  }

  applyFlowHighlighting();
});

graph.on('dbltap', 'node', (event: cytoscape.EventObject) => {
  const nodeId = event.target.id();
  if (!nodeId) {
    return;
  }

  if (toggleReductionExpansion(nodeId)) {
    return;
  }

  openNodeSource(nodeId);
});

refreshButton.addEventListener('click', () => {
  refreshButton.disabled = true;
  statusText.textContent = 'Refreshing graph...';
  vscode.postMessage({ type: 'refreshGraph' });
});

layoutButton.addEventListener('click', () => {
  currentLayoutMode = currentLayoutMode === 'clustered' ? 'force' : 'clustered';
  layoutButton.textContent =
    currentLayoutMode === 'clustered' ? 'Layout: Clustered' : 'Layout: Force';

  if (latestGraphData) {
    applyLayout(latestGraphData, true);
  }
});

fitButton.addEventListener('click', () => {
  graph.fit(graph.elements(), 80);
  updateZoomResetLabel();
});

zoomInButton.addEventListener('click', () => {
  zoomByFactor(1.16);
});

zoomOutButton.addEventListener('click', () => {
  zoomByFactor(1 / 1.16);
});

zoomResetButton.addEventListener('click', () => {
  graph.zoom({
    level: 1,
    renderedPosition: { x: graph.width() / 2, y: graph.height() / 2 }
  });
  updateZoomResetLabel();
});

flowList.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  const button = target?.closest<HTMLButtonElement>('button[data-flow-id]');
  if (!button) {
    return;
  }

  const nextFlowId = button.dataset.flowId;
  if (!nextFlowId) {
    return;
  }

  stopPlayback();
  selectedFlowId = nextFlowId;
  selectedStepIndex = 0;
  renderFlowSidebar();
  applyFlowHighlighting();

  const activeFlow = getSelectedFlow();
  if (activeFlow && activeFlow.nodeIds.length > 0) {
    focusNode(activeFlow.nodeIds[0], true);
  }
});

flowSteps.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  const button = target?.closest<HTMLButtonElement>('button[data-step-index]');
  if (!button) {
    return;
  }

  const stepIndexText = button.dataset.stepIndex;
  if (!stepIndexText) {
    return;
  }

  const stepIndex = Number.parseInt(stepIndexText, 10);
  if (!Number.isFinite(stepIndex)) {
    return;
  }

  const activeFlow = getSelectedFlow();
  if (!activeFlow || stepIndex < 0 || stepIndex >= activeFlow.nodeIds.length) {
    return;
  }

  selectedStepIndex = stepIndex;
  renderFlowSteps(activeFlow);
  applyFlowHighlighting();
  focusNode(activeFlow.nodeIds[stepIndex], true);
});

flowMinLength.addEventListener('change', () => {
  flowFilters.minSteps = Number.parseInt(flowMinLength.value, 10) || 1;
  applyFlowFilters();
});

flowConfidence.addEventListener('input', () => {
  const value = Number.parseInt(flowConfidence.value, 10);
  flowFilters.minConfidence = Number.isFinite(value) ? value / 100 : 0;
  flowConfidenceValue.textContent = `${Math.round(flowFilters.minConfidence * 100)}%`;
  applyFlowFilters();
});

flowModule.addEventListener('change', () => {
  flowFilters.moduleId = flowModule.value;
  applyFlowFilters();
});

flowClearButton.addEventListener('click', () => {
  stopPlayback();
  selectedFlowId = undefined;
  selectedStepIndex = undefined;
  selectedNodeId = undefined;
  renderFlowSidebar();
  applyFlowHighlighting();
});

focusFile.addEventListener('change', () => {
  focusFilters.moduleNodeId = focusFile.value;
  applyFlowHighlighting();
});

focusNeighborhood.addEventListener('change', () => {
  focusFilters.neighborhoodOnly = focusNeighborhood.checked;
  applyFlowHighlighting();
});

dependencyDirection.addEventListener('change', () => {
  const value = dependencyDirection.value;
  if (value === 'upstream' || value === 'downstream' || value === 'both') {
    dependencyTraversal.direction = value;
  }
  applyFlowHighlighting();
});

dependencyHops.addEventListener('input', () => {
  const value = Number.parseInt(dependencyHops.value, 10);
  dependencyTraversal.maxHops = Number.isFinite(value) ? clamp(value, 1, 8) : 3;
  dependencyHopsValue.textContent = String(dependencyTraversal.maxHops);
  applyFlowHighlighting();
});

callPathEntry.addEventListener('change', () => {
  callPathExplorer.entryNodeId = callPathEntry.value;
  if (callPathExplorer.enabled) {
    applyFlowFilters();
  }
});

callPathDepth.addEventListener('input', () => {
  const value = Number.parseInt(callPathDepth.value, 10);
  callPathExplorer.maxDepth = Number.isFinite(value) ? clamp(value, 2, 14) : 8;
  callPathDepthValue.textContent = String(callPathExplorer.maxDepth);
  if (callPathExplorer.enabled) {
    applyFlowFilters();
  }
});

callPathRunButton.addEventListener('click', () => {
  callPathExplorer.entryNodeId = callPathEntry.value;
  if (!callPathExplorer.entryNodeId) {
    callPathStatus.textContent = 'Select an entry function to explore call paths.';
    return;
  }

  callPathExplorer.enabled = true;
  applyFlowFilters();
});

callPathClearButton.addEventListener('click', () => {
  callPathExplorer.enabled = false;
  callPathStatus.textContent = 'Auto mode: discovering broad flow patterns.';
  applyFlowFilters();
});

dataFlowSource.addEventListener('change', () => {
  dataFlowExplorer.sourceNodeId = dataFlowSource.value;
  if (dataFlowExplorer.enabled) {
    applyFlowHighlighting();
  }
});

dataFlowDirection.addEventListener('change', () => {
  const value = dataFlowDirection.value;
  if (value === 'forward' || value === 'backward' || value === 'both') {
    dataFlowExplorer.direction = value;
  }
  if (dataFlowExplorer.enabled) {
    applyFlowHighlighting();
  }
});

dataFlowHops.addEventListener('input', () => {
  const value = Number.parseInt(dataFlowHops.value, 10);
  dataFlowExplorer.maxHops = Number.isFinite(value) ? clamp(value, 1, 10) : 4;
  dataFlowHopsValue.textContent = String(dataFlowExplorer.maxHops);
  if (dataFlowExplorer.enabled) {
    applyFlowHighlighting();
  }
});

dataFlowRunButton.addEventListener('click', () => {
  dataFlowExplorer.sourceNodeId = dataFlowSource.value || selectedNodeId || '';
  if (!dataFlowExplorer.sourceNodeId) {
    dataFlowStatus.textContent = 'Select a source node to trace data flow.';
    return;
  }

  if (!dataFlowSource.value && dataFlowExplorer.sourceNodeId) {
    dataFlowSource.value = dataFlowExplorer.sourceNodeId;
  }

  dataFlowExplorer.enabled = true;
  applyFlowHighlighting();
});

dataFlowClearButton.addEventListener('click', () => {
  dataFlowExplorer.enabled = false;
  latestDataFlowAnalysis = undefined;
  dataFlowStatus.textContent = 'Select a source node to trace data transformations.';
  applyFlowHighlighting();
});

focusClearButton.addEventListener('click', () => {
  selectedNodeId = undefined;
  focusFilters.moduleNodeId = 'all';
  focusFilters.neighborhoodOnly = false;
  focusFile.value = 'all';
  focusNeighborhood.checked = false;
  applyFlowHighlighting();
});

layerStructuralToggle.addEventListener('change', () => {
  layerVisibility.structural = layerStructuralToggle.checked;
  rerenderGraphFromSource();
});

layerDependencyToggle.addEventListener('change', () => {
  layerVisibility.dependency = layerDependencyToggle.checked;
  rerenderGraphFromSource();
});

layerDataFlowToggle.addEventListener('change', () => {
  layerVisibility.dataflow = layerDataFlowToggle.checked;
  rerenderGraphFromSource();
});

layerExecutionToggle.addEventListener('change', () => {
  layerVisibility.execution = layerExecutionToggle.checked;
  rerenderGraphFromSource();
});

executionStartButton.addEventListener('click', () => {
  if (executionTraceRunning) {
    return;
  }

  executionStatus.textContent = 'Starting runtime trace...';
  vscode.postMessage({ type: 'startExecutionTrace' });
});

executionStopButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'stopExecutionTrace' });
});

executionPrevButton.addEventListener('click', () => {
  stepExecution(-1);
});

executionNextButton.addEventListener('click', () => {
  stepExecution(1);
});

executionPlayButton.addEventListener('click', () => {
  if (isExecutionPlaybackRunning) {
    stopExecutionPlayback();
    return;
  }

  startExecutionPlayback();
});

editCreateButton.addEventListener('click', () => {
  const moduleNodeId = editCreateModule.value;
  const functionName = editCreateName.value.trim();

  if (!moduleNodeId || !functionName) {
    graphEditStatus.textContent = 'Create failed: module and function name are required.';
    return;
  }

  vscode.postMessage({
    type: 'createGraphFunction',
    moduleNodeId,
    functionName,
    inputs: parseCsvValues(editCreateInputs.value),
    outputs: parseCsvValues(editCreateOutputs.value)
  });
  graphEditStatus.textContent = `Creating ${functionName}...`;
});

editConnectButton.addEventListener('click', () => {
  const sourceNodeId = editConnectSource.value;
  const targetNodeId = editConnectTarget.value;

  if (!sourceNodeId || !targetNodeId) {
    graphEditStatus.textContent = 'Connect failed: source and target functions are required.';
    return;
  }

  if (sourceNodeId === targetNodeId) {
    graphEditStatus.textContent = 'Connect failed: source and target must be different nodes.';
    return;
  }

  vscode.postMessage({
    type: 'connectGraphNodes',
    sourceNodeId,
    targetNodeId
  });
  graphEditStatus.textContent = 'Generating call edge in code...';
});

editRenameButton.addEventListener('click', () => {
  const newName = editRenameName.value.trim();
  if (!selectedNodeId) {
    graphEditStatus.textContent = 'Rename failed: select a node in the graph first.';
    return;
  }

  if (!newName) {
    graphEditStatus.textContent = 'Rename failed: enter a new node name.';
    return;
  }

  vscode.postMessage({
    type: 'renameGraphNode',
    nodeId: selectedNodeId,
    newName
  });
  graphEditStatus.textContent = `Renaming selected node to ${newName}...`;
});

editMoveButton.addEventListener('click', () => {
  const targetModuleNodeId = editMoveModule.value;
  if (!selectedNodeId) {
    graphEditStatus.textContent = 'Move failed: select a function node first.';
    return;
  }

  if (!targetModuleNodeId) {
    graphEditStatus.textContent = 'Move failed: choose a target module.';
    return;
  }

  vscode.postMessage({
    type: 'moveGraphNode',
    nodeId: selectedNodeId,
    targetModuleNodeId
  });
  graphEditStatus.textContent = 'Moving selected function to target module...';
});

collapseFunctionsToggle.addEventListener('change', () => {
  reductionState.collapseInternalFunctions = collapseFunctionsToggle.checked;
  if (!reductionState.collapseInternalFunctions) {
    reductionState.expandedModuleIds.clear();
  }

  updateReductionHint();
  rerenderGraphFromSource();
});

collapseLibrariesToggle.addEventListener('change', () => {
  reductionState.collapseLibraries = collapseLibrariesToggle.checked;
  if (!reductionState.collapseLibraries) {
    reductionState.librariesExpanded = false;
  }

  updateReductionHint();
  rerenderGraphFromSource();
});

openSourceButton.addEventListener('click', () => {
  if (!selectedNodeId) {
    return;
  }

  openNodeSource(selectedNodeId);
});

flowPrevButton.addEventListener('click', () => {
  const flow = getSelectedFlow();
  if (!flow || flow.nodeIds.length === 0) {
    return;
  }

  const currentIndex = typeof selectedStepIndex === 'number' ? selectedStepIndex : 0;
  selectedStepIndex = Math.max(currentIndex - 1, 0);
  renderFlowSteps(flow);
  applyFlowHighlighting();
  focusNode(flow.nodeIds[selectedStepIndex], true);
});

flowNextButton.addEventListener('click', () => {
  advanceStep();
});

flowPlayButton.addEventListener('click', () => {
  if (isPlaybackRunning) {
    stopPlayback();
    return;
  }

  startPlayback();
});

graph.on('zoom', () => {
  updateZoomResetLabel();
  scheduleMinimapRender();
});

graph.on('pan', () => {
  scheduleMinimapRender();
});

window.addEventListener('resize', () => {
  graph.resize();
  updateZoomResetLabel();
  scheduleMinimapRender();
});

minimapCanvas.addEventListener('pointerdown', (event: PointerEvent) => {
  if (!minimapTransform) {
    return;
  }

  const rect = minimapCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const modelX = (x - minimapTransform.offsetX) / minimapTransform.scale;
  const modelY = (y - minimapTransform.offsetY) / minimapTransform.scale;

  centerGraphAtModelPoint(modelX, modelY);
});

window.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;

  if (message.type === 'graphError') {
    statusText.textContent = `Graph error: ${message.message}`;
    refreshButton.disabled = false;
    return;
  }

  if (message.type === 'graphData') {
    renderGraph(message.payload);
    refreshButton.disabled = false;
    return;
  }

  if (message.type === 'graphEditResult') {
    graphEditStatus.textContent = message.ok ? `Success: ${message.message}` : `Error: ${message.message}`;
    if (message.ok) {
      editCreateName.value = '';
      editCreateInputs.value = '';
      editCreateOutputs.value = '';
      editRenameName.value = '';
    }
    return;
  }

  if (message.type === 'executionReset') {
    resetExecutionTrace(message.entryFilePath);
    return;
  }

  if (message.type === 'executionEvent') {
    ingestExecutionEvent(message.payload);
    return;
  }

  if (message.type === 'executionComplete') {
    completeExecutionTrace(message.summary);
    return;
  }

  if (message.type === 'executionError') {
    executionStatus.textContent = `Trace error: ${message.message}`;
    executionTraceRunning = false;
    stopExecutionPlayback();
    updateExecutionControls();
  }
});

updateZoomResetLabel();
focusNeighborhood.checked = focusFilters.neighborhoodOnly;
dependencyDirection.value = dependencyTraversal.direction;
dependencyHops.value = String(dependencyTraversal.maxHops);
dependencyHopsValue.textContent = String(dependencyTraversal.maxHops);
callPathDepth.value = String(callPathExplorer.maxDepth);
callPathDepthValue.textContent = String(callPathExplorer.maxDepth);
dataFlowDirection.value = dataFlowExplorer.direction;
dataFlowHops.value = String(dataFlowExplorer.maxHops);
dataFlowHopsValue.textContent = String(dataFlowExplorer.maxHops);
layerStructuralToggle.checked = layerVisibility.structural;
layerDependencyToggle.checked = layerVisibility.dependency;
layerDataFlowToggle.checked = layerVisibility.dataflow;
layerExecutionToggle.checked = layerVisibility.execution;
collapseFunctionsToggle.checked = reductionState.collapseInternalFunctions;
collapseLibrariesToggle.checked = reductionState.collapseLibraries;
updateReductionHint();
flowConfidenceValue.textContent = `${Math.round(flowFilters.minConfidence * 100)}%`;
updateExecutionControls();
scheduleMinimapRender();
vscode.postMessage({ type: 'ready' });

function renderGraph(graphData: GraphData): void {
  latestGraphData = graphData;
  const displayedGraphData = buildDisplayedGraphData(graphData);
  latestDisplayedGraphData = displayedGraphData;

  nodeCatalog.clear();
  callEdgeByPair.clear();
  anyEdgeByPair.clear();
  edgeCatalog.clear();

  for (const node of displayedGraphData.nodes) {
    nodeCatalog.set(node.id, node);
  }

  for (const edge of displayedGraphData.edges) {
    edgeCatalog.set(edge.id, edge);
    const pairKey = flowPairKey(edge.source, edge.target);
    if (!anyEdgeByPair.has(pairKey)) {
      anyEdgeByPair.set(pairKey, edge.id);
    }

    if (edge.type !== 'call') {
      continue;
    }

    callEdgeByPair.set(pairKey, edge.id);
  }

  if (selectedNodeId && !nodeCatalog.has(selectedNodeId)) {
    selectedNodeId = undefined;
  }

  syncFocusFileOptions(graphData);
  syncModuleFilterOptions(graphData);
  syncGraphEditOptions(graphData);
  syncExplorationOptions(graphData);

  const elements = [
    ...displayedGraphData.nodes.map((node) => ({
      data: {
        id: node.id,
        label: formatNodeLabel(node),
        type: node.type,
        filePath: node.filePath,
        line: node.line,
        external: node.metadata?.external ? 1 : 0,
        reductionCollapsed: node.metadata?.reductionCollapsed ? 1 : 0
      }
    })),
    ...displayedGraphData.edges.map((edge) => ({
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.type
      }
    }))
  ];

  graph.elements().remove();
  graph.add(elements);

  applyFlowFilters();

  const shouldFit = !hasInitializedViewport;
  applyLayout(displayedGraphData, shouldFit);
  if (displayedGraphData.nodes.length > 0) {
    hasInitializedViewport = true;
  }

  applyFlowHighlighting();
  applyExecutionOverlay(false);

  const diagnostics = graphData.meta.diagnostics;
  const totalCalls = diagnostics.resolvedCalls + diagnostics.unresolvedCalls;
  const relationSuffix =
    totalCalls > 0
      ? ` | calls: ${diagnostics.resolvedCalls}/${totalCalls} resolved`
      : ' | calls: none';
  const modelSuffix = ` | classes: ${diagnostics.indexedClasses} | vars: ${diagnostics.indexedVariables} | dataflow: ${diagnostics.dataFlowEdges}`;
  const activeLayers = [
    layerVisibility.structural ? 'S' : '',
    layerVisibility.dependency ? 'D' : '',
    layerVisibility.dataflow ? 'F' : '',
    layerVisibility.execution ? 'X' : ''
  ]
    .filter((token) => token.length > 0)
    .join('');
  const layerSuffix = ` | layers: ${activeLayers || 'none'}`;
  const cacheTotal = diagnostics.parserCacheHits + diagnostics.parserCacheMisses;
  const cacheSuffix =
    cacheTotal > 0
      ? ` | cache: ${diagnostics.parserCacheHits}/${cacheTotal}`
      : '';
  const warningCompact = graphData.meta.parseWarnings.length > 0 ? ' | warnings' : '';

  statusText.textContent = `${graphData.meta.workspaceName} | ${displayedGraphData.nodes.length} nodes | ${displayedGraphData.edges.length} edges${relationSuffix}${modelSuffix}${layerSuffix}${cacheSuffix}${warningCompact}`;
}

function renderFlowSidebar(): void {
  flowMeta.textContent = `${flowDefinitions.length} discovered`;
  flowList.replaceChildren();

  if (flowDefinitions.length === 0) {
    const placeholder = document.createElement('li');
    placeholder.className = 'flow-placeholder';
    placeholder.textContent = 'No callable flow patterns detected yet.';
    flowList.appendChild(placeholder);
    renderFlowSteps(undefined);
    updatePlaybackControls();
    return;
  }

  for (const [index, flow] of flowDefinitions.entries()) {
    const item = document.createElement('li');
    item.className = 'flow-list-item';

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.flowId = flow.id;
    button.className = `flow-button${flow.id === selectedFlowId ? ' active' : ''}`;
    button.textContent = `${index + 1}. ${flow.name}`;

    item.appendChild(button);
    flowList.appendChild(item);
  }

  renderFlowSteps(getSelectedFlow());
  updatePlaybackControls();
}

function renderFlowSteps(flow: FlowDefinition | undefined): void {
  flowSteps.replaceChildren();

  if (!flow) {
    const placeholder = document.createElement('li');
    placeholder.className = 'flow-placeholder';
    placeholder.textContent = 'Select a flow to highlight the involved blocks.';
    flowSteps.appendChild(placeholder);
    renderExplainPanel(undefined);
    return;
  }

  if (typeof selectedStepIndex !== 'number' || selectedStepIndex >= flow.nodeIds.length) {
    selectedStepIndex = 0;
  }

  flow.nodeIds.forEach((nodeId, index) => {
    const node = nodeCatalog.get(nodeId);
    const item = document.createElement('li');
    item.className = 'flow-step-item';

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.stepIndex = String(index);
    button.className = `flow-step-button${index === selectedStepIndex ? ' active' : ''}`;

    const label = document.createElement('span');
    label.textContent = node?.name ?? nodeId;

    const order = document.createElement('span');
    order.className = 'step-index';
    order.textContent = String(index + 1);

    button.appendChild(label);
    button.appendChild(order);
    item.appendChild(button);
    flowSteps.appendChild(item);
  });

  renderExplainPanel(flow);
}

function applyFlowHighlighting(): void {
  graph.elements().removeClass(
    'dimmed flow-node flow-edge flow-current flow-current-edge node-selected node-incoming node-outgoing node-impact node-dataflow edge-incoming edge-outgoing edge-impact edge-dataflow execution-visited execution-active execution-traversed'
  );

  const activeFlow = getSelectedFlow();
  if (!activeFlow) {
    applyFocusFilters();
    renderExplainPanel(undefined);
    updatePlaybackControls();
    applyExecutionOverlay(false);
    scheduleMinimapRender();
    return;
  }

  const activeNodes = new Set(activeFlow.nodeIds);
  const activeEdges = new Set(activeFlow.edgeIds);

  graph.nodes().forEach((node) => {
    if (activeNodes.has(node.id())) {
      node.addClass('flow-node');
      return;
    }

    node.addClass('dimmed');
  });

  graph.edges().forEach((edge) => {
    if (activeEdges.has(edge.id())) {
      edge.addClass('flow-edge');
      return;
    }

    edge.addClass('dimmed');
  });

  if (
    typeof selectedStepIndex === 'number' &&
    selectedStepIndex >= 0 &&
    selectedStepIndex < activeFlow.nodeIds.length
  ) {
    const currentNodeId = activeFlow.nodeIds[selectedStepIndex];
    graph.getElementById(currentNodeId).addClass('flow-current');

    if (selectedStepIndex > 0) {
      const currentEdgeId = activeFlow.edgeIds[selectedStepIndex - 1];
      if (currentEdgeId) {
        graph.getElementById(currentEdgeId).addClass('flow-current-edge');
      }
    }
  }

  applyFocusFilters();

  renderExplainPanel(activeFlow);
  updatePlaybackControls();
  applyExecutionOverlay(false);
  scheduleMinimapRender();
}

function getSelectedFlow(): FlowDefinition | undefined {
  if (!selectedFlowId) {
    return undefined;
  }

  return flowDefinitions.find((flow) => flow.id === selectedFlowId);
}

function focusNode(nodeId: string, animate: boolean): void {
  const element = graph.getElementById(nodeId);
  if (element.length === 0) {
    return;
  }

  const zoomLevel = clamp(Math.max(graph.zoom(), 0.9), MIN_ZOOM, MAX_ZOOM);
  if (animate) {
    graph.animate(
      {
        center: { eles: element },
        zoom: zoomLevel
      },
      {
        duration: 220,
        easing: 'ease-out-cubic'
      }
    );
    return;
  }

  graph.center(element);
}

function buildFlowDefinitions(graphData: GraphData, filters: FlowFilters): FlowDefinition[] {
  const functionNodes = graphData.nodes.filter((node) => node.type === 'function');
  if (functionNodes.length === 0) {
    return [];
  }

  const functionIds = new Set(functionNodes.map((node) => node.id));
  const functionIdList = [...functionIds];
  const adjacencySets = new Map<string, Set<string>>();
  const reverseAdjacencySets = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  const outdegree = new Map<string, number>();

  for (const functionNode of functionNodes) {
    adjacencySets.set(functionNode.id, new Set<string>());
    reverseAdjacencySets.set(functionNode.id, new Set<string>());
    indegree.set(functionNode.id, 0);
    outdegree.set(functionNode.id, 0);
  }

  const callEdges = graphData.edges.filter(
    (edge) => edge.type === 'call' && getEdgeConfidence(edge) >= filters.minConfidence
  );

  for (const edge of callEdges) {
    if (!functionIds.has(edge.source) || !functionIds.has(edge.target)) {
      continue;
    }

    adjacencySets.get(edge.source)?.add(edge.target);
    reverseAdjacencySets.get(edge.target)?.add(edge.source);
  }

  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();
  for (const nodeId of functionIdList) {
    adjacency.set(nodeId, [...(adjacencySets.get(nodeId) ?? [])]);
    reverseAdjacency.set(nodeId, [...(reverseAdjacencySets.get(nodeId) ?? [])]);
  }

  for (const [sourceId, targets] of adjacency.entries()) {
    outdegree.set(sourceId, targets.length);

    for (const targetId of targets) {
      indegree.set(targetId, (indegree.get(targetId) ?? 0) + 1);
    }
  }

  const nameById = new Map(functionNodes.map((node) => [node.id, node.name]));
  const maxFlowDepth = 14;
  const maxFlowCount = 220;
  const maxPathsPerStart = 36;
  const maxStartsPerComponent = 8;
  const maxBranchesPerHop = 6;
  const pathSignatures = new Set<string>();
  const paths: string[][] = [];
  const componentList = computeWeaklyConnectedComponents(functionIdList, adjacency, reverseAdjacency)
    .filter((component) => component.some((nodeId) => (outdegree.get(nodeId) ?? 0) > 0));

  if (componentList.length === 0) {
    return functionNodes
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 25)
      .map((node, index) => ({
        id: `flow-${index + 1}`,
        name: node.name,
        nodeIds: [node.id],
        edgeIds: []
      }))
      .filter((flow) => flow.nodeIds.length >= filters.minSteps);
  }

  const addPath = (path: string[]): void => {
    if (path.length === 0 || paths.length >= maxFlowCount) {
      return;
    }

    const signature = path.join('>');
    if (pathSignatures.has(signature)) {
      return;
    }

    pathSignatures.add(signature);
    paths.push(path);

    if (path.length >= 4 && paths.length < maxFlowCount) {
      // Capture meaningful sub-flows from long traces so mid-graph behavior is discoverable.
      for (let start = 1; start <= path.length - 3; start += 1) {
        const subpath = path.slice(start);
        const subSignature = subpath.join('>');
        if (!pathSignatures.has(subSignature)) {
          pathSignatures.add(subSignature);
          paths.push(subpath);
          if (paths.length >= maxFlowCount) {
            break;
          }
        }
      }
    }
  };

  const walk = (
    componentNodes: Set<string>,
    startId: string,
    path: string[],
    currentId: string,
    visited: Set<string>,
    budget: { count: number }
  ): void => {
    if (budget.count >= maxPathsPerStart) {
      return;
    }

    if (paths.length >= maxFlowCount) {
      return;
    }

    const nextCandidates = prioritizeFlowCandidates(
      (adjacency.get(currentId) ?? []).filter((candidate) => componentNodes.has(candidate)),
      outdegree,
      indegree,
      nameById
    ).slice(0, maxBranchesPerHop);

    if (nextCandidates.length === 0 || path.length >= maxFlowDepth) {
      addPath(path);
      budget.count += 1;
      return;
    }

    let expanded = false;
    for (const nextId of nextCandidates) {
      if (visited.has(nextId)) {
        continue;
      }

      expanded = true;
      visited.add(nextId);
      walk(componentNodes, startId, [...path, nextId], nextId, visited, budget);
      visited.delete(nextId);

      if (paths.length >= maxFlowCount || budget.count >= maxPathsPerStart) {
        return;
      }
    }

    if (!expanded) {
      addPath(path);
      budget.count += 1;
    }
  };

  for (const component of componentList) {
    const componentNodeSet = new Set(component);
    const starts = chooseFlowStarts(component, indegree, outdegree, nameById).slice(0, maxStartsPerComponent);

    for (const startId of starts) {
      const budget = { count: 0 };
      const visited = new Set<string>([startId]);
      walk(componentNodeSet, startId, [startId], startId, visited, budget);
      if (paths.length >= maxFlowCount) {
        break;
      }
    }

    if (paths.length >= maxFlowCount) {
      break;
    }
  }

  // Ensure simple direct flows are always discoverable.
  for (const edge of callEdges) {
    if (paths.length >= maxFlowCount) {
      break;
    }

    if (!functionIds.has(edge.source) || !functionIds.has(edge.target)) {
      continue;
    }

    addPath([edge.source, edge.target]);
  }

  if (paths.length === 0) {
    const singletonPaths = functionIdList
      .sort((a, b) => (nameById.get(a) ?? a).localeCompare(nameById.get(b) ?? b))
      .slice(0, 25)
      .map((nodeId) => [nodeId]);

    singletonPaths.forEach((path) => addPath(path));
  }

  return paths
    .map((nodeIds, index) => {
      const firstName = nameById.get(nodeIds[0]) ?? nodeIds[0];
      const lastName = nameById.get(nodeIds[nodeIds.length - 1]) ?? nodeIds[nodeIds.length - 1];
      const name =
        nodeIds.length === 1
          ? firstName
          : nodeIds.length === 2
            ? `${firstName} -> ${lastName}`
            : `${firstName} -> ${lastName} (+${nodeIds.length - 2})`;

      const edgeIds = nodeIds
        .slice(0, -1)
        .map((sourceId, edgeIndex) => callEdgeByPair.get(flowPairKey(sourceId, nodeIds[edgeIndex + 1])))
        .filter((edgeId): edgeId is string => typeof edgeId === 'string');

      return {
        id: `flow-${index + 1}`,
        name,
        nodeIds,
        edgeIds
      };
    })
    .filter((flow) => flow.nodeIds.length >= filters.minSteps)
    .filter((flow) => {
      if (filters.moduleId === 'all') {
        return true;
      }

      return flow.nodeIds.some((nodeId) => {
        const node = nodeCatalog.get(nodeId);
        if (!node) {
          return false;
        }

        return getModuleNodeId(node) === filters.moduleId;
      });
    })
    .sort((a, b) => b.nodeIds.length - a.nodeIds.length)
    .slice(0, 40);
}

function chooseFlowStarts(
  component: string[],
  indegree: Map<string, number>,
  outdegree: Map<string, number>,
  nameById: Map<string, string>
): string[] {
  const keywordRegex = /^(main|run|start|handle|process|execute|dispatch|entry|bootstrap|init|load)/i;
  const sortedByPriority = [...component].sort((a, b) => {
    const outDiff = (outdegree.get(b) ?? 0) - (outdegree.get(a) ?? 0);
    if (outDiff !== 0) {
      return outDiff;
    }

    const inDiff = (indegree.get(a) ?? 0) - (indegree.get(b) ?? 0);
    if (inDiff !== 0) {
      return inDiff;
    }

    return (nameById.get(a) ?? a).localeCompare(nameById.get(b) ?? b);
  });

  const keywordStarts = sortedByPriority.filter((id) => keywordRegex.test(nameById.get(id) ?? id));
  const pureEntryStarts = sortedByPriority.filter(
    (id) => (indegree.get(id) ?? 0) === 0 && (outdegree.get(id) ?? 0) > 0
  );
  const fanoutStarts = sortedByPriority.filter((id) => (outdegree.get(id) ?? 0) > 0);

  const result: string[] = [];
  const appendUnique = (values: string[]): void => {
    for (const value of values) {
      if (!result.includes(value)) {
        result.push(value);
      }
    }
  };

  appendUnique(keywordStarts);
  appendUnique(pureEntryStarts);
  appendUnique(fanoutStarts);

  if (result.length === 0 && component.length > 0) {
    result.push(component[0]);
  }

  return result;
}

function prioritizeFlowCandidates(
  candidates: string[],
  outdegree: Map<string, number>,
  indegree: Map<string, number>,
  nameById: Map<string, string>
): string[] {
  return [...candidates].sort((a, b) => {
    const outDiff = (outdegree.get(b) ?? 0) - (outdegree.get(a) ?? 0);
    if (outDiff !== 0) {
      return outDiff;
    }

    const inDiff = (indegree.get(a) ?? 0) - (indegree.get(b) ?? 0);
    if (inDiff !== 0) {
      return inDiff;
    }

    return (nameById.get(a) ?? a).localeCompare(nameById.get(b) ?? b);
  });
}

function computeWeaklyConnectedComponents(
  nodes: string[],
  adjacency: Map<string, string[]>,
  reverseAdjacency: Map<string, string[]>
): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const node of nodes) {
    if (visited.has(node)) {
      continue;
    }

    const queue = [node];
    const component: string[] = [];
    visited.add(node);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      component.push(current);
      const neighbors = [...(adjacency.get(current) ?? []), ...(reverseAdjacency.get(current) ?? [])];

      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) {
          continue;
        }

        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    components.push(component);
  }

  return components;
}

function flowPairKey(sourceId: string, targetId: string): string {
  return `${sourceId}=>${targetId}`;
}

function rerenderGraphFromSource(): void {
  if (!latestGraphData) {
    return;
  }

  renderGraph(latestGraphData);
}

function updateReductionHint(): void {
  if (!reductionState.collapseInternalFunctions && !reductionState.collapseLibraries) {
    reductionHint.textContent = 'Reduction off: full graph shown.';
    return;
  }

  const parts: string[] = [];

  if (reductionState.collapseInternalFunctions) {
    const expandedCount = reductionState.expandedModuleIds.size;
    parts.push(
      expandedCount > 0
        ? `${expandedCount} module${expandedCount === 1 ? '' : 's'} expanded`
        : 'modules collapsed'
    );
  }

  if (reductionState.collapseLibraries) {
    parts.push(reductionState.librariesExpanded ? 'libraries expanded' : 'libraries collapsed');
  }

  reductionHint.textContent = `Double-click to expand on demand (${parts.join(', ')}).`;
}

function toggleReductionExpansion(nodeId: string): boolean {
  if (nodeId === COLLAPSED_LIBRARIES_NODE_ID && reductionState.collapseLibraries) {
    reductionState.librariesExpanded = !reductionState.librariesExpanded;
    updateReductionHint();
    rerenderGraphFromSource();
    return true;
  }

  const node = nodeCatalog.get(nodeId);
  if (!node || node.type !== 'module' || node.metadata?.external) {
    return false;
  }

  if (!reductionState.collapseInternalFunctions) {
    return false;
  }

  if (reductionState.expandedModuleIds.has(nodeId)) {
    reductionState.expandedModuleIds.delete(nodeId);
  } else {
    reductionState.expandedModuleIds.add(nodeId);
  }

  updateReductionHint();
  rerenderGraphFromSource();
  return true;
}

function buildDisplayedGraphData(source: GraphData): GraphData {
  const layerFiltered = buildLayerFilteredGraphData(source);
  const sourceNodesById = new Map(layerFiltered.nodes.map((node) => [node.id, node]));
  const functionNodes = layerFiltered.nodes.filter((node) => node.type === 'function');
  const moduleNodes = layerFiltered.nodes.filter((node) => node.type === 'module');
  const externalModuleIds = new Set(
    moduleNodes.filter((node) => node.metadata?.external).map((node) => node.id)
  );

  const moduleIds = new Set(moduleNodes.filter((node) => !node.metadata?.external).map((node) => node.id));
  for (const expandedId of [...reductionState.expandedModuleIds]) {
    if (!moduleIds.has(expandedId)) {
      reductionState.expandedModuleIds.delete(expandedId);
    }
  }

  const hiddenFunctionIds = new Set<string>();
  const hiddenFunctionCountByModule = new Map<string, number>();

  if (reductionState.collapseInternalFunctions) {
    for (const functionNode of functionNodes) {
      const moduleNodeId = getModuleNodeId(functionNode);
      if (!moduleNodeId || reductionState.expandedModuleIds.has(moduleNodeId)) {
        continue;
      }

      hiddenFunctionIds.add(functionNode.id);
      hiddenFunctionCountByModule.set(
        moduleNodeId,
        (hiddenFunctionCountByModule.get(moduleNodeId) ?? 0) + 1
      );
    }
  }

  const hiddenExternalModuleIds =
    reductionState.collapseLibraries && !reductionState.librariesExpanded ? externalModuleIds : new Set<string>();

  const visibleNodes: GraphNode[] = [];

  for (const node of layerFiltered.nodes) {
    if (hiddenFunctionIds.has(node.id)) {
      continue;
    }

    if (hiddenExternalModuleIds.has(node.id)) {
      continue;
    }

    const metadata = { ...(node.metadata ?? {}) };
    const collapsedCount = hiddenFunctionCountByModule.get(node.id) ?? 0;
    if (node.type === 'module' && collapsedCount > 0) {
      metadata.collapsedFunctions = collapsedCount;
      metadata.reductionCollapsed = true;
    }

    visibleNodes.push({
      ...node,
      metadata
    });
  }

  const aggregatedCallCounts = new Map<string, number>();
  const aggregatedLibraryDeps = new Map<string, number>();
  const visibleEdges: GraphEdge[] = [];

  for (const edge of layerFiltered.edges) {
    const sourceHiddenFunction = hiddenFunctionIds.has(edge.source);
    const targetHiddenFunction = hiddenFunctionIds.has(edge.target);
    const sourceHiddenExternal = hiddenExternalModuleIds.has(edge.source);
    const targetHiddenExternal = hiddenExternalModuleIds.has(edge.target);

    if (sourceHiddenExternal || targetHiddenExternal) {
      if (
        edge.type === 'dependency' &&
        reductionState.collapseLibraries &&
        !reductionState.librariesExpanded &&
        !sourceHiddenExternal
      ) {
        aggregatedLibraryDeps.set(edge.source, (aggregatedLibraryDeps.get(edge.source) ?? 0) + 1);
      }
      continue;
    }

    if (sourceHiddenFunction || targetHiddenFunction) {
      if (edge.type === 'call' && reductionState.collapseInternalFunctions) {
        const sourceModuleId = thisNodeModuleId(sourceNodesById.get(edge.source));
        const targetModuleId = thisNodeModuleId(sourceNodesById.get(edge.target));

        if (sourceModuleId && targetModuleId) {
          const key = flowPairKey(sourceModuleId, targetModuleId);
          aggregatedCallCounts.set(key, (aggregatedCallCounts.get(key) ?? 0) + 1);
        }
      }

      continue;
    }

    visibleEdges.push({ ...edge });
  }

  for (const [pairKey, count] of aggregatedCallCounts.entries()) {
    const [sourceId, targetId] = pairKey.split('=>');
    if (!sourceId || !targetId) {
      continue;
    }

    visibleEdges.push({
      id: `edge:reduction:call:${sourceId}->${targetId}`,
      source: sourceId,
      target: targetId,
      type: 'call',
      layer: 'dependency',
      metadata: {
        reduced: true,
        collapsedCallCount: count,
        confidence: 0.52,
        provenance: 'heuristic',
        reason: `${count} collapsed function call${count === 1 ? '' : 's'}`
      }
    });
  }

  if (reductionState.collapseLibraries && !reductionState.librariesExpanded) {
    const hiddenExternalCount = hiddenExternalModuleIds.size;

    if (hiddenExternalCount > 0) {
      visibleNodes.push({
        id: COLLAPSED_LIBRARIES_NODE_ID,
        type: 'module',
        name: 'Libraries',
        layers: ['structural', 'dependency'],
        roles: ['container', 'external'],
        metadata: {
          external: true,
          reduced: true,
          collapsedLibrariesCount: hiddenExternalCount,
          reductionCollapsed: true
        }
      });

      for (const [sourceId, count] of aggregatedLibraryDeps.entries()) {
        visibleEdges.push({
          id: `edge:reduction:dep:${sourceId}->${COLLAPSED_LIBRARIES_NODE_ID}`,
          source: sourceId,
          target: COLLAPSED_LIBRARIES_NODE_ID,
          type: 'dependency',
          layer: 'dependency',
          metadata: {
            reduced: true,
            collapsedDependencyCount: count,
            confidence: 0.66,
            provenance: 'heuristic',
            reason: `${count} hidden library dependenc${count === 1 ? 'y' : 'ies'}`
          }
        });
      }
    }
  }

  return {
    ...source,
    nodes: visibleNodes,
    edges: visibleEdges
  };
}

function buildLayerFilteredGraphData(source: GraphData): GraphData {
  const visibleLayers = new Set<GraphLayer>();
  if (layerVisibility.structural) {
    visibleLayers.add('structural');
  }
  if (layerVisibility.dependency) {
    visibleLayers.add('dependency');
  }
  if (layerVisibility.dataflow) {
    visibleLayers.add('dataflow');
  }
  if (layerVisibility.execution) {
    visibleLayers.add('execution');
  }

  const edges = source.edges.filter((edge) => visibleLayers.has(edge.layer));
  const connectedNodeIds = new Set<string>();
  for (const edge of edges) {
    connectedNodeIds.add(edge.source);
    connectedNodeIds.add(edge.target);
  }

  const nodes = source.nodes.filter(
    (node) => node.layers.some((layer) => visibleLayers.has(layer)) || connectedNodeIds.has(node.id)
  );

  return {
    ...source,
    nodes,
    edges
  };
}

function applyFlowFilters(): void {
  if (!latestDisplayedGraphData) {
    flowDefinitions = [];
    selectedFlowId = undefined;
    selectedStepIndex = undefined;
    renderFlowSidebar();
    applyFlowHighlighting();
    return;
  }

  stopPlayback();
  if (callPathExplorer.enabled && callPathExplorer.entryNodeId) {
    flowDefinitions = buildCallPathsFromEntry(latestDisplayedGraphData, flowFilters, callPathExplorer);
    const branchPoints = countBranchPoints(latestDisplayedGraphData, flowDefinitions);
    callPathStatus.textContent = [
      `Entry mode: ${flowDefinitions.length} path${flowDefinitions.length === 1 ? '' : 's'} discovered`,
      `Entry: ${nodeCatalog.get(callPathExplorer.entryNodeId)?.name ?? callPathExplorer.entryNodeId}`,
      `Max depth: ${callPathExplorer.maxDepth}`,
      `Branch points touched: ${branchPoints}`
    ].join('\n');
  } else {
    flowDefinitions = buildFlowDefinitions(latestDisplayedGraphData, flowFilters);
    callPathStatus.textContent = 'Auto mode: discovering broad flow patterns.';
  }

  if (selectedFlowId && !flowDefinitions.some((flow) => flow.id === selectedFlowId)) {
    selectedFlowId = undefined;
    selectedStepIndex = undefined;
  }

  renderFlowSidebar();
  applyFlowHighlighting();
}

function buildCallPathsFromEntry(
  graphData: GraphData,
  filters: FlowFilters,
  explorer: CallPathExplorerState
): FlowDefinition[] {
  const functionNodes = graphData.nodes.filter((node) => node.type === 'function');
  const functionIds = new Set(functionNodes.map((node) => node.id));
  if (!functionIds.has(explorer.entryNodeId)) {
    return [];
  }

  const adjacency = new Map<string, string[]>();
  for (const id of functionIds) {
    adjacency.set(id, []);
  }

  const callEdges = graphData.edges.filter(
    (edge) => edge.type === 'call' && getEdgeConfidence(edge) >= filters.minConfidence
  );
  for (const edge of callEdges) {
    if (!functionIds.has(edge.source) || !functionIds.has(edge.target)) {
      continue;
    }
    adjacency.get(edge.source)?.push(edge.target);
  }

  const nameById = new Map(functionNodes.map((node) => [node.id, node.name]));
  const paths: string[][] = [];
  const signatures = new Set<string>();
  const maxPaths = 260;
  const maxDepth = clamp(explorer.maxDepth, 2, 14);

  const appendPath = (path: string[]): void => {
    if (path.length === 0 || paths.length >= maxPaths) {
      return;
    }

    const signature = path.join('>');
    if (signatures.has(signature)) {
      return;
    }

    signatures.add(signature);
    paths.push(path);
  };

  const walk = (path: string[], currentId: string, visited: Set<string>): void => {
    if (paths.length >= maxPaths) {
      return;
    }

    const nextCandidates = prioritizeFlowCandidates(
      (adjacency.get(currentId) ?? []).filter((candidate) => !visited.has(candidate)),
      new Map([...adjacency.entries()].map(([id, targets]) => [id, targets.length])),
      new Map<string, number>(),
      nameById
    );

    if (nextCandidates.length === 0 || path.length >= maxDepth) {
      appendPath(path);
      return;
    }

    for (const nextId of nextCandidates) {
      visited.add(nextId);
      walk([...path, nextId], nextId, visited);
      visited.delete(nextId);
      if (paths.length >= maxPaths) {
        break;
      }
    }
  };

  walk([explorer.entryNodeId], explorer.entryNodeId, new Set<string>([explorer.entryNodeId]));
  if (paths.length === 0) {
    appendPath([explorer.entryNodeId]);
  }

  return paths
    .map((nodeIds, index) => {
      const firstName = nameById.get(nodeIds[0]) ?? nodeIds[0];
      const lastName = nameById.get(nodeIds[nodeIds.length - 1]) ?? nodeIds[nodeIds.length - 1];
      const name =
        nodeIds.length === 1
          ? firstName
          : nodeIds.length === 2
            ? `${firstName} -> ${lastName}`
            : `${firstName} -> ${lastName} (+${nodeIds.length - 2})`;

      const edgeIds = nodeIds
        .slice(0, -1)
        .map((sourceId, edgeIndex) => callEdgeByPair.get(flowPairKey(sourceId, nodeIds[edgeIndex + 1])))
        .filter((edgeId): edgeId is string => typeof edgeId === 'string');

      return {
        id: `entry-flow-${index + 1}`,
        name,
        nodeIds,
        edgeIds
      };
    })
    .filter((flow) => flow.nodeIds.length >= filters.minSteps)
    .slice(0, 80);
}

function countBranchPoints(graphData: GraphData, flows: FlowDefinition[]): number {
  if (flows.length === 0) {
    return 0;
  }

  const functionIds = new Set(graphData.nodes.filter((node) => node.type === 'function').map((node) => node.id));
  const outdegree = new Map<string, number>();
  for (const id of functionIds) {
    outdegree.set(id, 0);
  }

  for (const edge of graphData.edges) {
    if (edge.type !== 'call' || !functionIds.has(edge.source) || !functionIds.has(edge.target)) {
      continue;
    }

    outdegree.set(edge.source, (outdegree.get(edge.source) ?? 0) + 1);
  }

  const branchNodes = new Set<string>();
  for (const flow of flows) {
    for (const nodeId of flow.nodeIds) {
      if ((outdegree.get(nodeId) ?? 0) > 1) {
        branchNodes.add(nodeId);
      }
    }
  }

  return branchNodes.size;
}

function syncModuleFilterOptions(graphData: GraphData): void {
  const previousValue = flowModule.value || flowFilters.moduleId;
  const options = [{ value: 'all', label: 'All modules' }];

  graphData.nodes
    .filter((node) => node.type === 'module' && !node.metadata?.external)
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((moduleNode) => {
      options.push({ value: moduleNode.id, label: moduleNode.name });
    });

  flowModule.replaceChildren();
  options.forEach((optionData) => {
    const option = document.createElement('option');
    option.value = optionData.value;
    option.textContent = optionData.label;
    flowModule.appendChild(option);
  });

  const resolvedValue = options.some((option) => option.value === previousValue) ? previousValue : 'all';
  flowModule.value = resolvedValue;
  flowFilters.moduleId = resolvedValue;
}

function syncFocusFileOptions(graphData: GraphData): void {
  const previousValue = focusFile.value || focusFilters.moduleNodeId;
  const options = [{ value: 'all', label: 'All files' }];

  graphData.nodes
    .filter((node) => node.type === 'module' && !node.metadata?.external)
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((moduleNode) => {
      options.push({ value: moduleNode.id, label: moduleNode.name });
    });

  focusFile.replaceChildren();
  options.forEach((optionData) => {
    const option = document.createElement('option');
    option.value = optionData.value;
    option.textContent = optionData.label;
    focusFile.appendChild(option);
  });

  const resolvedValue = options.some((option) => option.value === previousValue) ? previousValue : 'all';
  focusFile.value = resolvedValue;
  focusFilters.moduleNodeId = resolvedValue;
}

function syncGraphEditOptions(graphData: GraphData): void {
  const previousCreateModule = editCreateModule.value;
  const previousMoveModule = editMoveModule.value;
  const previousConnectSource = editConnectSource.value;
  const previousConnectTarget = editConnectTarget.value;

  const moduleOptions = graphData.nodes
    .filter((node) => node.type === 'module' && !node.metadata?.external)
    .sort((a, b) => a.name.localeCompare(b.name));
  const functionOptions = graphData.nodes
    .filter((node) => node.type === 'function')
    .sort((a, b) => a.name.localeCompare(b.name));

  applySelectOptions(
    editCreateModule,
    [{ value: '', label: 'Select module' }, ...moduleOptions.map((node) => ({ value: node.id, label: node.name }))],
    previousCreateModule
  );
  applySelectOptions(
    editMoveModule,
    [{ value: '', label: 'Select module' }, ...moduleOptions.map((node) => ({ value: node.id, label: node.name }))],
    previousMoveModule
  );
  applySelectOptions(
    editConnectSource,
    [{ value: '', label: 'Select source' }, ...functionOptions.map((node) => ({ value: node.id, label: node.name }))],
    previousConnectSource
  );
  applySelectOptions(
    editConnectTarget,
    [{ value: '', label: 'Select target' }, ...functionOptions.map((node) => ({ value: node.id, label: node.name }))],
    previousConnectTarget
  );
}

function applySelectOptions(
  select: HTMLSelectElement,
  options: Array<{ value: string; label: string }>,
  preferredValue: string
): void {
  select.replaceChildren();
  options.forEach((optionData) => {
    const option = document.createElement('option');
    option.value = optionData.value;
    option.textContent = optionData.label;
    select.appendChild(option);
  });

  const resolved = options.some((option) => option.value === preferredValue)
    ? preferredValue
    : options[0]?.value ?? '';
  select.value = resolved;
}

function parseCsvValues(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function syncExplorationOptions(graphData: GraphData): void {
  const previousEntry = callPathExplorer.entryNodeId || callPathEntry.value;
  const previousDataFlowSource = dataFlowExplorer.sourceNodeId || dataFlowSource.value;

  const functionNodes = graphData.nodes
    .filter((node) => node.type === 'function')
    .sort((a, b) => a.name.localeCompare(b.name));
  const dataFlowNodes = graphData.nodes
    .filter((node) => node.layers.includes('dataflow'))
    .sort((a, b) => a.name.localeCompare(b.name));

  applySelectOptions(
    callPathEntry,
    [{ value: '', label: 'Select entry function' }, ...functionNodes.map((node) => ({ value: node.id, label: node.name }))],
    previousEntry
  );
  applySelectOptions(
    dataFlowSource,
    [{ value: '', label: 'Select source node' }, ...dataFlowNodes.map((node) => ({ value: node.id, label: `${node.name} (${node.type})` }))],
    previousDataFlowSource
  );

  callPathExplorer.entryNodeId = callPathEntry.value;
  dataFlowExplorer.sourceNodeId = dataFlowSource.value;
}

function applyFocusFilters(): void {
  const keepNodeIds = new Set<string>();
  const keepEdgeIds = new Set<string>();

  if (focusFilters.moduleNodeId !== 'all') {
    keepNodeIds.add(focusFilters.moduleNodeId);

    for (const [nodeId, node] of nodeCatalog.entries()) {
      if (node.id === focusFilters.moduleNodeId) {
        keepNodeIds.add(nodeId);
        continue;
      }

      if (getModuleNodeId(node) === focusFilters.moduleNodeId) {
        keepNodeIds.add(nodeId);
      }
    }

    graph.edges().forEach((edge) => {
      if (keepNodeIds.has(edge.source().id()) && keepNodeIds.has(edge.target().id())) {
        keepEdgeIds.add(edge.id());
      }
    });

    graph.nodes().forEach((node) => {
      if (!keepNodeIds.has(node.id())) {
        node.addClass('dimmed');
      }
    });

    graph.edges().forEach((edge) => {
      if (!keepEdgeIds.has(edge.id())) {
        edge.addClass('dimmed');
      }
    });
  }

  applyDependencyHighlighting();
}

function applyDependencyHighlighting(): void {
  if (!selectedNodeId) {
    latestDependencyAnalysis = undefined;
    dependencyStatus.textContent = 'Select a node to analyze dependency impact.';
    applyDataFlowHighlighting();
    updateNodeInspector();
    return;
  }

  const selectedNode = graph.getElementById(selectedNodeId);
  if (selectedNode.length === 0) {
    latestDependencyAnalysis = undefined;
    dependencyStatus.textContent = 'Selected node is not visible in the current graph filters.';
    applyDataFlowHighlighting();
    updateNodeInspector();
    return;
  }

  selectedNode.addClass('node-selected');

  const analysis = analyzeDependencyTraversal(selectedNodeId, dependencyTraversal.maxHops);
  latestDependencyAnalysis = analysis;

  const showUpstream = dependencyTraversal.direction !== 'downstream';
  const showDownstream = dependencyTraversal.direction !== 'upstream';

  if (showUpstream) {
    for (const nodeId of analysis.upstreamNodeIds) {
      graph.getElementById(nodeId).addClass('node-incoming').removeClass('dimmed');
    }
    for (const edgeId of analysis.upstreamEdgeIds) {
      graph.getElementById(edgeId).addClass('edge-incoming').removeClass('dimmed');
    }
  }

  if (showDownstream) {
    for (const nodeId of analysis.downstreamNodeIds) {
      graph.getElementById(nodeId).addClass('node-outgoing').removeClass('dimmed');
    }
    for (const edgeId of analysis.downstreamEdgeIds) {
      graph.getElementById(edgeId).addClass('edge-outgoing').removeClass('dimmed');
    }
  }

  // Impact analysis is always based on transitive upstream dependents.
  for (const nodeId of analysis.upstreamNodeIds) {
    graph.getElementById(nodeId).addClass('node-impact').removeClass('dimmed');
  }
  for (const edgeId of analysis.upstreamEdgeIds) {
    graph.getElementById(edgeId).addClass('edge-impact').removeClass('dimmed');
  }

  dependencyStatus.textContent = [
    `Traversal: ${dependencyTraversal.direction}, hops <= ${dependencyTraversal.maxHops}`,
    `Upstream dependents: ${analysis.upstreamNodeIds.size}`,
    `Downstream dependencies: ${analysis.downstreamNodeIds.size}`,
    `Blast radius: ${analysis.blastRadiusNodeCount} node${analysis.blastRadiusNodeCount === 1 ? '' : 's'}`
  ].join('\n');

  if (!focusFilters.neighborhoodOnly) {
    applyDataFlowHighlighting();
    updateNodeInspector();
    return;
  }

  const neighborhoodNodeIds = new Set<string>([
    selectedNodeId,
    ...analysis.upstreamNodeIds,
    ...analysis.downstreamNodeIds
  ]);

  const selectedNodeMeta = nodeCatalog.get(selectedNodeId);
  const moduleNodeId = selectedNodeMeta ? getModuleNodeId(selectedNodeMeta) : undefined;
  if (moduleNodeId) {
    neighborhoodNodeIds.add(moduleNodeId);
  }

  const neighborhoodEdgeIds = new Set<string>([
    ...analysis.upstreamEdgeIds,
    ...analysis.downstreamEdgeIds
  ]);

  graph.nodes().forEach((node) => {
    if (!neighborhoodNodeIds.has(node.id())) {
      node.addClass('dimmed');
    }
  });

  graph.edges().forEach((edge) => {
    if (!neighborhoodEdgeIds.has(edge.id())) {
      edge.addClass('dimmed');
    }
  });

  applyDataFlowHighlighting();
  updateNodeInspector();
}

function analyzeDependencyTraversal(
  rootNodeId: string,
  maxHops: number
): DependencyAnalysisSnapshot {
  const safeMaxHops = clamp(maxHops, 1, 8);
  const upstreamNodeIds = new Set<string>();
  const downstreamNodeIds = new Set<string>();
  const upstreamEdgeIds = new Set<string>();
  const downstreamEdgeIds = new Set<string>();

  const traverse = (
    direction: 'upstream' | 'downstream',
    nodeSet: Set<string>,
    edgeSet: Set<string>
  ): void => {
    const visited = new Set<string>([rootNodeId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: rootNodeId, depth: 0 }];

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) {
        continue;
      }

      if (item.depth >= safeMaxHops) {
        continue;
      }

      const node = graph.getElementById(item.id);
      if (node.length === 0) {
        continue;
      }

      const edgeCollection = direction === 'upstream' ? node.incomers('edge') : node.outgoers('edge');
      edgeCollection.forEach((edge) => {
        if (!isDependencyTraversableEdge(edge)) {
          return;
        }

        const nextNodeId = direction === 'upstream' ? edge.source().id() : edge.target().id();
        if (!nextNodeId) {
          return;
        }

        edgeSet.add(edge.id());

        if (visited.has(nextNodeId)) {
          return;
        }

        visited.add(nextNodeId);
        nodeSet.add(nextNodeId);
        queue.push({ id: nextNodeId, depth: item.depth + 1 });
      });
    }
  };

  traverse('upstream', upstreamNodeIds, upstreamEdgeIds);
  traverse('downstream', downstreamNodeIds, downstreamEdgeIds);

  return {
    upstreamNodeIds,
    downstreamNodeIds,
    upstreamEdgeIds,
    downstreamEdgeIds,
    blastRadiusNodeCount: upstreamNodeIds.size
  };
}

function isDependencyTraversableEdge(edge: cytoscape.EdgeSingular): boolean {
  const edgeType = String(edge.data('type'));
  return (
    edgeType === 'call' ||
    edgeType === 'dependency' ||
    edgeType === 'class-usage' ||
    edgeType === 'dataflow'
  );
}

function applyDataFlowHighlighting(): void {
  if (!dataFlowExplorer.enabled) {
    latestDataFlowAnalysis = undefined;
    return;
  }

  const sourceNodeId = dataFlowExplorer.sourceNodeId;
  if (!sourceNodeId) {
    latestDataFlowAnalysis = undefined;
    dataFlowStatus.textContent = 'Select a source node to trace data transformations.';
    return;
  }

  const sourceNode = graph.getElementById(sourceNodeId);
  if (sourceNode.length === 0) {
    latestDataFlowAnalysis = undefined;
    dataFlowStatus.textContent = 'Selected data-flow source is not visible in current filters.';
    return;
  }

  const analysis = analyzeDataFlowTraversal(
    sourceNodeId,
    dataFlowExplorer.maxHops,
    dataFlowExplorer.direction
  );
  latestDataFlowAnalysis = analysis;

  for (const nodeId of analysis.nodeIds) {
    graph.getElementById(nodeId).addClass('node-dataflow').removeClass('dimmed');
  }
  for (const edgeId of analysis.edgeIds) {
    graph.getElementById(edgeId).addClass('edge-dataflow').removeClass('dimmed');
  }

  dataFlowStatus.textContent = [
    `Source: ${nodeCatalog.get(sourceNodeId)?.name ?? sourceNodeId}`,
    `Direction: ${dataFlowExplorer.direction}, hops <= ${dataFlowExplorer.maxHops}`,
    `Reachable nodes: ${analysis.nodeIds.size}`,
    `Transformations traversed: ${analysis.transformationCount}`,
    `Forward: ${analysis.forwardCount}, Backward: ${analysis.backwardCount}`
  ].join('\n');
}

function analyzeDataFlowTraversal(
  sourceNodeId: string,
  maxHops: number,
  direction: DataFlowDirection
): DataFlowAnalysisSnapshot {
  const safeMaxHops = clamp(maxHops, 1, 10);
  const nodeIds = new Set<string>([sourceNodeId]);
  const edgeIds = new Set<string>();
  let forwardCount = 0;
  let backwardCount = 0;

  const traverse = (mode: 'forward' | 'backward'): number => {
    const visited = new Set<string>([sourceNodeId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: sourceNodeId, depth: 0 }];
    let traversed = 0;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.depth >= safeMaxHops) {
        continue;
      }

      const node = graph.getElementById(current.id);
      if (node.length === 0) {
        continue;
      }

      const edges = mode === 'forward' ? node.outgoers('edge') : node.incomers('edge');
      edges.forEach((edge) => {
        if (!isDataFlowTraversableEdge(edge)) {
          return;
        }

        const nextNodeId = mode === 'forward' ? edge.target().id() : edge.source().id();
        if (!nextNodeId) {
          return;
        }

        edgeIds.add(edge.id());
        nodeIds.add(nextNodeId);
        traversed += 1;

        if (visited.has(nextNodeId)) {
          return;
        }

        visited.add(nextNodeId);
        queue.push({ id: nextNodeId, depth: current.depth + 1 });
      });
    }

    return traversed;
  };

  if (direction === 'forward' || direction === 'both') {
    forwardCount = traverse('forward');
  }

  if (direction === 'backward' || direction === 'both') {
    backwardCount = traverse('backward');
  }

  return {
    sourceNodeId,
    nodeIds,
    edgeIds,
    forwardCount,
    backwardCount,
    transformationCount: edgeIds.size
  };
}

function isDataFlowTraversableEdge(edge: cytoscape.EdgeSingular): boolean {
  const edgeType = String(edge.data('type'));
  return edgeType === 'dataflow' || edgeType === 'call';
}

function openNodeSource(nodeId: string): void {
  const node = nodeCatalog.get(nodeId);
  if (!node || !node.filePath || typeof node.line !== 'number') {
    return;
  }

  vscode.postMessage({
    type: 'navigateToNode',
    nodeId
  });
}

function updateNodeInspector(): void {
  if (!selectedNodeId) {
    nodeInspector.textContent = 'Click a node to inspect dependencies.';
    openSourceButton.disabled = true;
    return;
  }

  const node = nodeCatalog.get(selectedNodeId);
  if (!node) {
    nodeInspector.textContent = 'Selected node is no longer available.';
    openSourceButton.disabled = true;
    return;
  }

  const cyNode = graph.getElementById(selectedNodeId);
  const incomingCount = cyNode.length > 0 ? cyNode.incomers('edge').length : 0;
  const outgoingCount = cyNode.length > 0 ? cyNode.outgoers('edge').length : 0;

  const lines = [
    `Node: ${node.name}`,
    `Type: ${node.type}`,
    `Incoming: ${incomingCount}`,
    `Outgoing: ${outgoingCount}`
  ];

  if (latestDependencyAnalysis && selectedNodeId) {
    lines.push(`Transitive upstream: ${latestDependencyAnalysis.upstreamNodeIds.size}`);
    lines.push(`Transitive downstream: ${latestDependencyAnalysis.downstreamNodeIds.size}`);
    lines.push(`Blast radius: ${latestDependencyAnalysis.blastRadiusNodeCount}`);
  }

  if (latestDataFlowAnalysis && latestDataFlowAnalysis.nodeIds.has(selectedNodeId)) {
    lines.push(`Data-flow reach: yes`);
    lines.push(`Data transformations: ${latestDataFlowAnalysis.transformationCount}`);
  }

  const moduleNodeId = getModuleNodeId(node);
  if (moduleNodeId) {
    const moduleNode = nodeCatalog.get(moduleNodeId);
    if (moduleNode?.name) {
      lines.push(`File: ${moduleNode.name}`);
    }
  }

  if (node.filePath && typeof node.line === 'number') {
    lines.push(`Location: ${node.filePath}:${node.line}`);
  }

  const runtimeEvent = latestExecutionEventByNodeId.get(node.id);
  if (runtimeEvent) {
    lines.push(`Runtime: ${runtimeEvent.eventType} @ step ${runtimeEvent.index + 1}`);

    if (runtimeEvent.inputs && Object.keys(runtimeEvent.inputs).length > 0) {
      lines.push(`Inputs: ${formatRuntimeObject(runtimeEvent.inputs)}`);
    }

    if (runtimeEvent.locals && Object.keys(runtimeEvent.locals).length > 0) {
      lines.push(`Intermediate: ${formatRuntimeObject(runtimeEvent.locals)}`);
    }

    if (runtimeEvent.eventType === 'return') {
      lines.push(`Output: ${formatRuntimeValue(runtimeEvent.output)}`);
    }
  }

  nodeInspector.textContent = lines.join('\n');
  openSourceButton.disabled = !(node.filePath && typeof node.line === 'number');
}

function startPlayback(): void {
  const flow = getSelectedFlow();
  if (!flow || flow.nodeIds.length === 0) {
    return;
  }

  if (typeof selectedStepIndex !== 'number') {
    selectedStepIndex = 0;
  }

  isPlaybackRunning = true;
  flowPlayButton.textContent = 'Pause';
  playbackTimer = window.setInterval(() => {
    const advanced = advanceStep();
    if (!advanced) {
      stopPlayback();
    }
  }, 760);

  updatePlaybackControls();
}

function stopPlayback(): void {
  if (playbackTimer) {
    clearInterval(playbackTimer);
    playbackTimer = undefined;
  }

  isPlaybackRunning = false;
  flowPlayButton.textContent = 'Play';
  updatePlaybackControls();
}

function advanceStep(): boolean {
  const flow = getSelectedFlow();
  if (!flow || flow.nodeIds.length === 0) {
    return false;
  }

  const currentIndex = typeof selectedStepIndex === 'number' ? selectedStepIndex : 0;
  if (currentIndex >= flow.nodeIds.length - 1) {
    return false;
  }

  selectedStepIndex = currentIndex + 1;
  renderFlowSteps(flow);
  applyFlowHighlighting();
  focusNode(flow.nodeIds[selectedStepIndex], true);
  return true;
}

function updatePlaybackControls(): void {
  const flow = getSelectedFlow();
  const hasFlow = Boolean(flow && flow.nodeIds.length > 0);
  const currentIndex = typeof selectedStepIndex === 'number' ? selectedStepIndex : 0;

  flowPrevButton.disabled = !hasFlow || currentIndex <= 0;
  flowNextButton.disabled = !hasFlow || !flow || currentIndex >= flow.nodeIds.length - 1;
  flowPlayButton.disabled = !hasFlow;
}

function resetExecutionTrace(entryFilePath: string): void {
  stopExecutionPlayback();
  executionEvents.splice(0, executionEvents.length);
  executionCursor = -1;
  latestExecutionEventByNodeId.clear();
  clearDynamicExecutionEdges();

  executionTraceRunning = true;
  layerVisibility.execution = true;
  layerExecutionToggle.checked = true;

  executionStatus.textContent = `Tracing ${entryFilePath}...`;
  executionNodeState.textContent = 'Waiting for runtime events...';
  updateExecutionControls();
  rerenderGraphFromSource();
}

function ingestExecutionEvent(traceEvent: ExecutionTraceEvent): void {
  executionEvents.push(traceEvent);
  executionCursor = executionEvents.length - 1;

  if (traceEvent.nodeId) {
    latestExecutionEventByNodeId.set(traceEvent.nodeId, traceEvent);
  }

  executionStatus.textContent = `Tracing... ${executionEvents.length} event${executionEvents.length === 1 ? '' : 's'}`;
  applyExecutionOverlay(true);
  updateExecutionControls();
}

function completeExecutionTrace(summary: { totalEvents: number; exitCode?: number; stopped?: boolean }): void {
  executionTraceRunning = false;
  stopExecutionPlayback();

  const parts: string[] = [];
  if (summary.stopped) {
    parts.push('stopped');
  } else {
    parts.push('complete');
  }
  parts.push(`${summary.totalEvents} events`);
  if (typeof summary.exitCode === 'number') {
    parts.push(`exit ${summary.exitCode}`);
  }

  executionStatus.textContent = `Trace ${parts.join(' | ')}`;
  updateExecutionControls();
  applyExecutionOverlay(false);
}

function startExecutionPlayback(): void {
  if (executionEvents.length === 0) {
    return;
  }

  if (executionCursor < 0) {
    executionCursor = 0;
  }

  isExecutionPlaybackRunning = true;
  executionPlayButton.textContent = 'Pause';
  updateExecutionControls();

  executionPlaybackTimer = window.setInterval(() => {
    const advanced = stepExecution(1, true);
    if (!advanced) {
      stopExecutionPlayback();
    }
  }, 520);
}

function stopExecutionPlayback(): void {
  if (executionPlaybackTimer) {
    clearInterval(executionPlaybackTimer);
    executionPlaybackTimer = undefined;
  }

  isExecutionPlaybackRunning = false;
  executionPlayButton.textContent = 'Play';
  updateExecutionControls();
}

function stepExecution(delta: number, autoFocus = true): boolean {
  if (executionEvents.length === 0) {
    return false;
  }

  const current = executionCursor < 0 ? 0 : executionCursor;
  const next = Math.min(executionEvents.length - 1, Math.max(0, current + delta));
  if (next === executionCursor) {
    return false;
  }

  executionCursor = next;
  applyExecutionOverlay(autoFocus);
  updateExecutionControls();
  return true;
}

function updateExecutionControls(): void {
  const hasEvents = executionEvents.length > 0;
  const hasCursor = executionCursor >= 0;

  executionStartButton.disabled = executionTraceRunning;
  executionStopButton.disabled = !executionTraceRunning;
  executionPrevButton.disabled = !hasEvents || !hasCursor || executionCursor <= 0;
  executionNextButton.disabled = !hasEvents || !hasCursor || executionCursor >= executionEvents.length - 1;
  executionPlayButton.disabled = !hasEvents;
  executionPlayButton.textContent = isExecutionPlaybackRunning ? 'Pause' : 'Play';
}

function clearDynamicExecutionEdges(): void {
  if (dynamicExecutionEdgeIds.size === 0) {
    return;
  }

  for (const edgeId of dynamicExecutionEdgeIds) {
    graph.getElementById(edgeId).remove();
  }

  dynamicExecutionEdgeIds.clear();
}

function applyExecutionOverlay(autoFocus: boolean): void {
  graph.nodes().removeClass('execution-visited execution-active');
  graph.edges().removeClass('execution-traversed');
  clearDynamicExecutionEdges();

  if (!layerVisibility.execution || executionEvents.length === 0 || executionCursor < 0) {
    updateExecutionNodeState(undefined);
    updateNodeInspector();
    return;
  }

  const terminalIndex = Math.min(executionCursor, executionEvents.length - 1);
  const visitedNodeIds = new Set<string>();

  for (let index = 0; index <= terminalIndex; index += 1) {
    const traceEvent = executionEvents[index];
    if (traceEvent?.nodeId && graph.getElementById(traceEvent.nodeId).length > 0) {
      visitedNodeIds.add(traceEvent.nodeId);
    }
  }

  for (const nodeId of visitedNodeIds) {
    graph.getElementById(nodeId).addClass('execution-visited').removeClass('dimmed');
  }

  for (let index = 1; index <= terminalIndex; index += 1) {
    const previous = executionEvents[index - 1];
    const current = executionEvents[index];
    if (!previous?.nodeId || !current?.nodeId || previous.nodeId === current.nodeId) {
      continue;
    }

    const pairKey = flowPairKey(previous.nodeId, current.nodeId);
    const existingEdgeId = anyEdgeByPair.get(pairKey);
    if (existingEdgeId) {
      graph.getElementById(existingEdgeId).addClass('execution-traversed').removeClass('dimmed');
      continue;
    }

    const dynamicEdgeId = `edge:execution:path:${index}:${previous.nodeId}->${current.nodeId}`;
    if (graph.getElementById(dynamicEdgeId).length === 0) {
      graph.add({
        data: {
          id: dynamicEdgeId,
          source: previous.nodeId,
          target: current.nodeId,
          type: 'execution-path'
        }
      });
      dynamicExecutionEdgeIds.add(dynamicEdgeId);
    }

    graph.getElementById(dynamicEdgeId).addClass('execution-traversed').removeClass('dimmed');
  }

  const activeEvent = executionEvents[terminalIndex];
  if (activeEvent?.nodeId && graph.getElementById(activeEvent.nodeId).length > 0) {
    const activeNode = graph.getElementById(activeEvent.nodeId);
    activeNode.addClass('execution-active').removeClass('dimmed');
    if (autoFocus) {
      focusNode(activeEvent.nodeId, true);
    }
  }

  updateExecutionNodeState(activeEvent);
  updateNodeInspector();
  scheduleMinimapRender();
}

function updateExecutionNodeState(event: ExecutionTraceEvent | undefined): void {
  if (!event) {
    executionNodeState.textContent = executionEvents.length === 0
      ? 'Run a trace to inspect inputs, outputs, and intermediate values.'
      : 'Select an execution step to inspect runtime state.';
    return;
  }

  const lines: string[] = [];
  lines.push(`Step: ${event.index + 1}/${executionEvents.length}`);
  lines.push(`Event: ${event.eventType}`);
  lines.push(`Location: ${event.filePath}:${event.line}`);
  lines.push(`Function: ${event.qualifiedName ?? event.functionName}`);

  if (event.inputs && Object.keys(event.inputs).length > 0) {
    lines.push(`Inputs: ${formatRuntimeObject(event.inputs)}`);
  }

  if (event.locals && Object.keys(event.locals).length > 0) {
    lines.push(`Intermediate: ${formatRuntimeObject(event.locals)}`);
  }

  if (event.eventType === 'return') {
    lines.push(`Output: ${formatRuntimeValue(event.output)}`);
  }

  if (event.eventType === 'exception' && event.exception) {
    lines.push(`Exception: ${event.exception}`);
  }

  executionNodeState.textContent = lines.join('\n');
}

function formatRuntimeObject(value: Record<string, unknown>): string {
  return formatRuntimeValue(value);
}

function formatRuntimeValue(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (!json) {
      return String(value);
    }

    return json.length > 260 ? `${json.slice(0, 257)}...` : json;
  } catch {
    return String(value);
  }
}

function renderExplainPanel(flow: FlowDefinition | undefined): void {
  if (!flow || typeof selectedStepIndex !== 'number' || selectedStepIndex < 0) {
    flowExplain.textContent = 'Select a flow step to inspect confidence and reasoning.';
    return;
  }

  const nodeId = flow.nodeIds[selectedStepIndex];
  const node = nodeCatalog.get(nodeId);
  const moduleNodeId = node ? getModuleNodeId(node) : undefined;
  const moduleNode = moduleNodeId ? nodeCatalog.get(moduleNodeId) : undefined;
  const incomingEdgeId = selectedStepIndex > 0 ? flow.edgeIds[selectedStepIndex - 1] : undefined;
  const incomingEdge = incomingEdgeId ? edgeCatalog.get(incomingEdgeId) : undefined;
  const edgeConfidence = incomingEdge ? Math.round(getEdgeConfidence(incomingEdge) * 100) : undefined;

  const lines: string[] = [];
  lines.push(`Node: ${node?.name ?? nodeId}`);

  if (moduleNode?.name) {
    lines.push(`Module: ${moduleNode.name}`);
  }

  if (node?.filePath && typeof node.line === 'number') {
    lines.push(`Location: ${node.filePath}:${node.line}`);
  }

  if (!incomingEdge) {
    lines.push('Incoming edge: flow entry point');
  } else {
    lines.push(`Incoming edge: ${incomingEdge.type}`);
    if (typeof edgeConfidence === 'number') {
      lines.push(`Confidence: ${edgeConfidence}%`);
    }
    if (incomingEdge.metadata?.provenance) {
      lines.push(`Provenance: ${incomingEdge.metadata.provenance}`);
    }
    if (incomingEdge.metadata?.reason) {
      lines.push(`Reason: ${incomingEdge.metadata.reason}`);
    }
  }

  flowExplain.textContent = lines.join('\n');
}

function getEdgeConfidence(edge: GraphEdge): number {
  const raw = edge.metadata?.confidence;
  if (typeof raw !== 'number' || Number.isNaN(raw)) {
    return 1;
  }

  return clamp(raw, 0, 1);
}

function applyLayout(graphData: GraphData, shouldFit: boolean): void {
  if (graphData.nodes.length === 0) {
    return;
  }

  if (currentLayoutMode === 'clustered') {
    applyClusteredLayout(graphData, shouldFit);
    return;
  }

  runLayout({
    name: 'cose',
    animate: false,
    nodeRepulsion: 240000,
    idealEdgeLength: 100,
    fit: shouldFit,
    padding: 40
  });
}

function applyClusteredLayout(graphData: GraphData, shouldFit: boolean): void {
  const positions = computeClusteredPositions(graphData);
  const positionMap: Record<string, Point> = {};
  for (const [id, point] of positions.entries()) {
    positionMap[id] = point;
  }

  runLayout({
    name: 'preset',
    positions: positionMap,
    animate: false,
    fit: shouldFit,
    padding: 70
  });
}

function computeClusteredPositions(graphData: GraphData): Map<string, Point> {
  const positions = new Map<string, Point>();
  const nodeById = new Map<string, GraphNode>();

  for (const node of graphData.nodes) {
    nodeById.set(node.id, node);
  }

  const moduleNodes = graphData.nodes.filter((node) => node.type === 'module');
  const internalModuleNodes = moduleNodes.filter((node) => !node.metadata?.external);
  const externalModuleNodes = moduleNodes.filter((node) => node.metadata?.external);

  const dependencyAdjacency = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const module of internalModuleNodes) {
    dependencyAdjacency.set(module.id, new Set<string>());
    indegree.set(module.id, 0);
  }

  for (const edge of graphData.edges) {
    if (edge.type !== 'dependency') {
      continue;
    }

    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (!sourceNode || !targetNode) {
      continue;
    }

    if (sourceNode.type !== 'module' || targetNode.type !== 'module') {
      continue;
    }

    if (sourceNode.metadata?.external || targetNode.metadata?.external) {
      continue;
    }

    dependencyAdjacency.get(sourceNode.id)?.add(targetNode.id);
    indegree.set(targetNode.id, (indegree.get(targetNode.id) ?? 0) + 1);
  }

  const queue = [...internalModuleNodes]
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  const layerByModuleId = new Map<string, number>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const currentLayer = layerByModuleId.get(current.id) ?? 0;

    for (const neighborId of dependencyAdjacency.get(current.id) ?? []) {
      layerByModuleId.set(neighborId, Math.max(layerByModuleId.get(neighborId) ?? 0, currentLayer + 1));
      indegree.set(neighborId, (indegree.get(neighborId) ?? 0) - 1);

      if ((indegree.get(neighborId) ?? 0) === 0) {
        const neighborNode = nodeById.get(neighborId);
        if (neighborNode) {
          queue.push(neighborNode);
          queue.sort((a, b) => a.name.localeCompare(b.name));
        }
      }
    }
  }

  for (const module of internalModuleNodes) {
    if (!layerByModuleId.has(module.id)) {
      layerByModuleId.set(module.id, 0);
    }
  }

  const modulesByLayer = new Map<number, GraphNode[]>();
  for (const module of internalModuleNodes) {
    const layer = layerByModuleId.get(module.id) ?? 0;
    const bucket = modulesByLayer.get(layer) ?? [];
    bucket.push(module);
    modulesByLayer.set(layer, bucket);
  }

  const horizontalSpacing = 460;
  const verticalSpacing = 300;
  const layerKeys = [...modulesByLayer.keys()].sort((a, b) => a - b);

  for (const layer of layerKeys) {
    const modules = (modulesByLayer.get(layer) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    const baseY = -((modules.length - 1) * verticalSpacing) / 2;

    modules.forEach((moduleNode, index) => {
      positions.set(moduleNode.id, {
        x: layer * horizontalSpacing,
        y: baseY + index * verticalSpacing
      });
    });
  }

  const rightMostLayer = layerKeys.length > 0 ? layerKeys[layerKeys.length - 1] : 0;
  const externalBaseY = -((externalModuleNodes.length - 1) * verticalSpacing) / 2;

  externalModuleNodes
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((moduleNode, index) => {
      positions.set(moduleNode.id, {
        x: (rightMostLayer + 1) * horizontalSpacing,
        y: externalBaseY + index * verticalSpacing
      });
    });

  const functionsByModuleId = new Map<string, GraphNode[]>();
  const classesByModuleId = new Map<string, GraphNode[]>();
  const unscopedFunctions: GraphNode[] = [];

  for (const node of graphData.nodes) {
    if (node.type === 'class') {
      const moduleNodeId = getModuleNodeId(node);
      if (!moduleNodeId) {
        continue;
      }

      const scoped = classesByModuleId.get(moduleNodeId) ?? [];
      scoped.push(node);
      classesByModuleId.set(moduleNodeId, scoped);
      continue;
    }

    if (node.type !== 'function') {
      continue;
    }

    const moduleNodeId = getModuleNodeId(node);
    if (!moduleNodeId) {
      unscopedFunctions.push(node);
      continue;
    }

    const scoped = functionsByModuleId.get(moduleNodeId) ?? [];
    scoped.push(node);
    functionsByModuleId.set(moduleNodeId, scoped);
  }

  for (const [moduleId, classes] of classesByModuleId.entries()) {
    const center = positions.get(moduleId) ?? { x: 0, y: 0 };
    const sortedClasses = [...classes].sort((a, b) => a.name.localeCompare(b.name));

    sortedClasses.forEach((classNode, index) => {
      const items = Math.max(sortedClasses.length, 1);
      const angle = (2 * Math.PI * index) / items - Math.PI / 2;
      const radius = 96;

      positions.set(classNode.id, {
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle)
      });
    });
  }

  for (const [moduleId, functions] of functionsByModuleId.entries()) {
    const center = positions.get(moduleId) ?? { x: 0, y: 0 };
    const sortedFunctions = [...functions].sort((a, b) => a.name.localeCompare(b.name));

    sortedFunctions.forEach((functionNode, index) => {
      const perRing = 10;
      const ring = Math.floor(index / perRing);
      const indexInRing = index % perRing;
      const itemsInRing = Math.min(perRing, sortedFunctions.length - ring * perRing);
      const angle = (2 * Math.PI * indexInRing) / Math.max(itemsInRing, 1) - Math.PI / 2;
      const radius = 130 + ring * 72;

      positions.set(functionNode.id, {
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle)
      });
    });
  }

  const orphanBaseY = -((unscopedFunctions.length - 1) * 95) / 2;
  unscopedFunctions
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((functionNode, index) => {
      positions.set(functionNode.id, {
        x: -horizontalSpacing,
        y: orphanBaseY + index * 95
      });
    });

  const variableNodes = graphData.nodes
    .filter((node) => node.type === 'variable')
    .sort((a, b) => a.name.localeCompare(b.name));
  const variableAnchorCounts = new Map<string, number>();

  for (const variableNode of variableNodes) {
    const functionNodeId = getFunctionNodeId(variableNode);
    const moduleNodeId = getModuleNodeId(variableNode);
    const anchorId = functionNodeId ?? moduleNodeId;
    if (!anchorId) {
      continue;
    }

    const anchor = positions.get(anchorId);
    if (!anchor) {
      continue;
    }

    const index = variableAnchorCounts.get(anchorId) ?? 0;
    variableAnchorCounts.set(anchorId, index + 1);

    const perRing = 8;
    const ring = Math.floor(index / perRing);
    const indexInRing = index % perRing;
    const angle = (2 * Math.PI * indexInRing) / perRing - Math.PI / 2;
    const radius = 44 + ring * 24;

    positions.set(variableNode.id, {
      x: anchor.x + radius * Math.cos(angle),
      y: anchor.y + radius * Math.sin(angle)
    });
  }

  return positions;
}

function formatNodeLabel(node: GraphNode): string {
  if (node.id === COLLAPSED_LIBRARIES_NODE_ID) {
    const count = typeof node.metadata?.collapsedLibrariesCount === 'number'
      ? node.metadata.collapsedLibrariesCount
      : 0;
    return count > 0 ? `Libraries (+${count})` : node.name;
  }

  if (node.type === 'module') {
    const collapsedCount =
      typeof node.metadata?.collapsedFunctions === 'number' ? node.metadata.collapsedFunctions : 0;
    if (collapsedCount > 0) {
      return `${node.name} (+${collapsedCount})`;
    }
  }

  return node.name;
}

function getModuleNodeId(node: GraphNode): string | undefined {
  const rawValue = node.metadata?.moduleNodeId;
  return typeof rawValue === 'string' ? rawValue : undefined;
}

function getFunctionNodeId(node: GraphNode): string | undefined {
  const rawValue = node.metadata?.functionNodeId;
  return typeof rawValue === 'string' ? rawValue : undefined;
}

function thisNodeModuleId(node: GraphNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  if (node.type === 'module') {
    return node.id;
  }

  return getModuleNodeId(node);
}

function zoomByFactor(factor: number): void {
  const nextZoom = clamp(graph.zoom() * factor, MIN_ZOOM, MAX_ZOOM);
  graph.zoom({
    level: nextZoom,
    renderedPosition: { x: graph.width() / 2, y: graph.height() / 2 }
  });
  updateZoomResetLabel();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function updateZoomResetLabel(): void {
  zoomResetButton.textContent = `${Math.round(graph.zoom() * 100)}%`;
}

function runLayout(options: cytoscape.LayoutOptions): void {
  const layout = graph.layout(options);
  graph.one('layoutstop', () => {
    scheduleMinimapRender();
    updateZoomResetLabel();
  });
  layout.run();
}

function centerGraphAtModelPoint(modelX: number, modelY: number): void {
  const zoom = graph.zoom();
  graph.pan({
    x: graph.width() / 2 - modelX * zoom,
    y: graph.height() / 2 - modelY * zoom
  });
  scheduleMinimapRender();
}

function scheduleMinimapRender(): void {
  if (minimapUpdateRequested) {
    return;
  }

  minimapUpdateRequested = true;
  requestAnimationFrame(() => {
    minimapUpdateRequested = false;
    renderMinimap();
  });
}

function renderMinimap(): void {
  const cssWidth = minimapCanvas.clientWidth;
  const cssHeight = minimapCanvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.floor(cssWidth * dpr));
  const pixelHeight = Math.max(1, Math.floor(cssHeight * dpr));

  if (minimapCanvas.width !== pixelWidth || minimapCanvas.height !== pixelHeight) {
    minimapCanvas.width = pixelWidth;
    minimapCanvas.height = pixelHeight;
  }

  minimapContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  minimapContext.clearRect(0, 0, cssWidth, cssHeight);

  const bounds = graph.elements().boundingBox();
  if (!Number.isFinite(bounds.w) || !Number.isFinite(bounds.h) || graph.nodes().length === 0) {
    minimapTransform = undefined;
    return;
  }

  const modelPadding = 30;
  const x1 = bounds.x1 - modelPadding;
  const y1 = bounds.y1 - modelPadding;
  const modelWidth = Math.max(bounds.w + modelPadding * 2, 1);
  const modelHeight = Math.max(bounds.h + modelPadding * 2, 1);
  const innerPadding = 6;
  const scale = Math.min(
    (cssWidth - innerPadding * 2) / modelWidth,
    (cssHeight - innerPadding * 2) / modelHeight
  );
  const offsetX = (cssWidth - modelWidth * scale) / 2 - x1 * scale;
  const offsetY = (cssHeight - modelHeight * scale) / 2 - y1 * scale;

  minimapTransform = { scale, offsetX, offsetY };

  drawMinimapNodes(scale, offsetX, offsetY);
  drawMinimapViewport(scale, offsetX, offsetY);
}

function drawMinimapNodes(scale: number, offsetX: number, offsetY: number): void {
  for (const node of graph.nodes()) {
    const position = node.position();
    const x = position.x * scale + offsetX;
    const y = position.y * scale + offsetY;
    const type = String(node.data('type'));
    const isExternal = Number(node.data('external')) === 1;

    const color = isExternal
      ? '#6c757d'
      : type === 'module'
        ? '#1b4332'
        : '#4f772d';
    const radius = type === 'module' ? 2.4 : 1.8;

    minimapContext.beginPath();
    minimapContext.fillStyle = color;
    minimapContext.arc(x, y, radius, 0, Math.PI * 2);
    minimapContext.fill();
  }
}

function drawMinimapViewport(scale: number, offsetX: number, offsetY: number): void {
  const viewport = getVisibleModelBounds();
  const x = viewport.x1 * scale + offsetX;
  const y = viewport.y1 * scale + offsetY;
  const width = Math.max((viewport.x2 - viewport.x1) * scale, 1);
  const height = Math.max((viewport.y2 - viewport.y1) * scale, 1);

  minimapContext.fillStyle = 'rgba(111, 255, 233, 0.11)';
  minimapContext.strokeStyle = 'rgba(111, 255, 233, 0.75)';
  minimapContext.lineWidth = 1;
  minimapContext.fillRect(x, y, width, height);
  minimapContext.strokeRect(x, y, width, height);
}

function getVisibleModelBounds(): { x1: number; y1: number; x2: number; y2: number } {
  const pan = graph.pan();
  const zoom = graph.zoom();

  return {
    x1: -pan.x / zoom,
    y1: -pan.y / zoom,
    x2: (graph.width() - pan.x) / zoom,
    y2: (graph.height() - pan.y) / zoom
  };
}

function getRequiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`FlowDE webview failed to resolve required element: ${selector}`);
  }

  return element;
}

function getRequiredCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('FlowDE webview failed to initialize minimap canvas context.');
  }

  return context;
}
