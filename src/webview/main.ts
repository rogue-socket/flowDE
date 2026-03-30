import cytoscape = require('cytoscape');

declare function acquireVsCodeApi(): {
  postMessage: (message: unknown) => void;
};

type GraphNodeType = 'function' | 'variable' | 'module';
type GraphEdgeType = 'call' | 'dependency' | 'contains';

interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  filePath?: string;
  line?: number;
  metadata?: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  metadata?: {
    confidence?: number;
    provenance?: string;
    reason?: string;
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
    diagnostics: {
      resolvedCalls: number;
      unresolvedCalls: number;
      ambiguousCalls: number;
      parserCacheHits: number;
      parserCacheMisses: number;
    };
    parseWarnings: string[];
  };
}

type IncomingMessage =
  | { type: 'graphData'; payload: GraphData }
  | { type: 'graphError'; message: string };

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
let hasInitializedViewport = false;
let minimapUpdateRequested = false;
let minimapTransform: MinimapTransform | undefined;
let flowDefinitions: FlowDefinition[] = [];
let selectedFlowId: string | undefined;
let selectedStepIndex: number | undefined;
let playbackTimer: number | undefined;
let isPlaybackRunning = false;
const nodeCatalog = new Map<string, GraphNode>();
const callEdgeByPair = new Map<string, string>();
const edgeCatalog = new Map<string, GraphEdge>();

const flowFilters: FlowFilters = {
  minSteps: Number.parseInt(flowMinLength.value, 10) || 2,
  minConfidence: Number.parseInt(flowConfidence.value, 10) / 100 || 0,
  moduleId: 'all'
};

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
  const filePath = node.data('filePath');
  const line = node.data('line');

  const activeFlow = getSelectedFlow();
  if (activeFlow) {
    const stepIndex = activeFlow.nodeIds.indexOf(nodeId);
    if (stepIndex >= 0) {
      selectedStepIndex = stepIndex;
      renderFlowSteps(activeFlow);
      applyFlowHighlighting();
    }
  }

  if (!nodeId || !filePath || typeof line !== 'number') {
    return;
  }

  vscode.postMessage({
    type: 'navigateToNode',
    nodeId
  });
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
  renderFlowSidebar();
  applyFlowHighlighting();
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
  }
});

updateZoomResetLabel();
flowConfidenceValue.textContent = `${Math.round(flowFilters.minConfidence * 100)}%`;
scheduleMinimapRender();
vscode.postMessage({ type: 'ready' });

function renderGraph(graphData: GraphData): void {
  latestGraphData = graphData;
  nodeCatalog.clear();
  callEdgeByPair.clear();
  edgeCatalog.clear();

  for (const node of graphData.nodes) {
    nodeCatalog.set(node.id, node);
  }

  for (const edge of graphData.edges) {
    edgeCatalog.set(edge.id, edge);

    if (edge.type !== 'call') {
      continue;
    }

    callEdgeByPair.set(flowPairKey(edge.source, edge.target), edge.id);
  }

  syncModuleFilterOptions(graphData);

  const elements = [
    ...graphData.nodes.map((node) => ({
      data: {
        id: node.id,
        label: formatNodeLabel(node),
        type: node.type,
        filePath: node.filePath,
        line: node.line,
        external: node.metadata?.external ? 1 : 0
      }
    })),
    ...graphData.edges.map((edge) => ({
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
  applyLayout(graphData, shouldFit);
  if (graphData.nodes.length > 0) {
    hasInitializedViewport = true;
  }

  applyFlowHighlighting();

  const diagnostics = graphData.meta.diagnostics;
  const totalCalls = diagnostics.resolvedCalls + diagnostics.unresolvedCalls;
  const relationSuffix =
    totalCalls > 0
      ? ` | calls: ${diagnostics.resolvedCalls}/${totalCalls} resolved`
      : ' | calls: none';
  const cacheTotal = diagnostics.parserCacheHits + diagnostics.parserCacheMisses;
  const cacheSuffix =
    cacheTotal > 0
      ? ` | cache: ${diagnostics.parserCacheHits}/${cacheTotal}`
      : '';
  const warningCompact = graphData.meta.parseWarnings.length > 0 ? ' | warnings' : '';

  statusText.textContent = `${graphData.meta.workspaceName} | ${graphData.nodes.length} nodes | ${graphData.edges.length} edges${relationSuffix}${cacheSuffix}${warningCompact}`;
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
  graph.elements().removeClass('dimmed flow-node flow-edge flow-current flow-current-edge');

  const activeFlow = getSelectedFlow();
  if (!activeFlow) {
    renderExplainPanel(undefined);
    updatePlaybackControls();
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

  renderExplainPanel(activeFlow);
  updatePlaybackControls();
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
  const adjacency = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  const outdegree = new Map<string, number>();

  for (const functionNode of functionNodes) {
    adjacency.set(functionNode.id, new Set<string>());
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

    adjacency.get(edge.source)?.add(edge.target);
  }

  for (const [sourceId, targets] of adjacency.entries()) {
    outdegree.set(sourceId, targets.size);

    for (const targetId of targets) {
      indegree.set(targetId, (indegree.get(targetId) ?? 0) + 1);
    }
  }

  const nameById = new Map(functionNodes.map((node) => [node.id, node.name]));
  const sortedRoots = [...functionIds]
    .filter((id) => (outdegree.get(id) ?? 0) > 0 && (indegree.get(id) ?? 0) === 0)
    .sort((a, b) => (nameById.get(a) ?? a).localeCompare(nameById.get(b) ?? b));

  const fallbackRoots = [...functionIds]
    .filter((id) => (outdegree.get(id) ?? 0) > 0)
    .sort((a, b) => (nameById.get(a) ?? a).localeCompare(nameById.get(b) ?? b));

  const roots = sortedRoots.length > 0 ? sortedRoots : fallbackRoots;
  const maxFlowDepth = 10;
  const maxFlowCount = 80;
  const pathSignatures = new Set<string>();
  const paths: string[][] = [];

  const addPath = (path: string[]): void => {
    const signature = path.join('>');
    if (pathSignatures.has(signature)) {
      return;
    }

    pathSignatures.add(signature);
    paths.push(path);
  };

  const walk = (path: string[], currentId: string): void => {
    if (paths.length >= maxFlowCount) {
      return;
    }

    const nextCandidates = [...(adjacency.get(currentId) ?? [])].filter(
      (candidate) => !path.includes(candidate)
    );

    if (nextCandidates.length === 0 || path.length >= maxFlowDepth) {
      addPath(path);
      return;
    }

    nextCandidates
      .sort((a, b) => (nameById.get(a) ?? a).localeCompare(nameById.get(b) ?? b))
      .forEach((nextId) => walk([...path, nextId], nextId));
  };

  for (const rootId of roots) {
    walk([rootId], rootId);
    if (paths.length >= maxFlowCount) {
      break;
    }
  }

  if (paths.length === 0) {
    const singletonPaths = [...functionNodes]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 25)
      .map((node) => [node.id]);

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

function flowPairKey(sourceId: string, targetId: string): string {
  return `${sourceId}=>${targetId}`;
}

function applyFlowFilters(): void {
  if (!latestGraphData) {
    flowDefinitions = [];
    selectedFlowId = undefined;
    selectedStepIndex = undefined;
    renderFlowSidebar();
    applyFlowHighlighting();
    return;
  }

  stopPlayback();
  flowDefinitions = buildFlowDefinitions(latestGraphData, flowFilters);

  if (selectedFlowId && !flowDefinitions.some((flow) => flow.id === selectedFlowId)) {
    selectedFlowId = undefined;
    selectedStepIndex = undefined;
  }

  renderFlowSidebar();
  applyFlowHighlighting();
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
  const unscopedFunctions: GraphNode[] = [];

  for (const node of graphData.nodes) {
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

  return positions;
}

function formatNodeLabel(node: GraphNode): string {
  return node.name;
}

function getModuleNodeId(node: GraphNode): string | undefined {
  const rawValue = node.metadata?.moduleNodeId;
  return typeof rawValue === 'string' ? rawValue : undefined;
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
