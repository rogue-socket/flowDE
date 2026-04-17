import cytoscape = require('cytoscape');

declare function acquireVsCodeApi(): {
  postMessage: (message: unknown) => void;
};

type GraphLayer = 'structural' | 'dependency';
type GraphNodeType = 'function' | 'module' | 'class';
type GraphEdgeType = 'call' | 'dependency' | 'contains' | 'class-usage';

interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  layers: GraphLayer[];
  roles: string[];
  filePath?: string;
  line?: number;
  moduleName?: string;
  metadata?: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  layer: GraphLayer;
  metadata?: Record<string, unknown>;
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
    diagnostics: Record<string, number>;
    parseWarnings: string[];
  };
}

type IncomingMessage =
  | { type: 'graphData'; payload: GraphData }
  | { type: 'graphError'; message: string };

type LayoutMode = 'vertical' | 'force';

interface FlowDefinition {
  id: string;
  nodeIds: string[];
  edgeIds: string[];
  label: string;
}

const vscode = acquireVsCodeApi();
const graphContainer = getRequiredElement<HTMLElement>('#graph-canvas');
const statusText = getRequiredElement<HTMLElement>('#status');
const flowMeta = getRequiredElement<HTMLElement>('#flow-meta');
const flowList = getRequiredElement<HTMLUListElement>('#flow-list');
const flowSteps = getRequiredElement<HTMLOListElement>('#flow-steps');
const nodeInspector = getRequiredElement<HTMLElement>('#node-inspector');
const openSourceButton = getRequiredElement<HTMLButtonElement>('#open-source-btn');
const maxDepthSlider = getRequiredElement<HTMLInputElement>('#max-depth');
const maxDepthValue = getRequiredElement<HTMLElement>('#max-depth-value');
const moduleFilter = getRequiredElement<HTMLSelectElement>('#module-filter');
const layoutButton = getRequiredElement<HTMLButtonElement>('#layout-btn');
const fitButton = getRequiredElement<HTMLButtonElement>('#fit-btn');
const refreshButton = getRequiredElement<HTMLButtonElement>('#refresh-btn');

let cy: cytoscape.Core | undefined;
let latestGraphData: GraphData | undefined;
let currentLayoutMode: LayoutMode = 'vertical';
let selectedFlowId: string | undefined;
let selectedNodeId: string | undefined;
let selectedEdgeId: string | undefined;
let flows: FlowDefinition[] = [];

const nodeCatalog = new Map<string, GraphNode>();
const edgeCatalog = new Map<string, GraphEdge>();

refreshButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'refreshGraph' });
});

fitButton.addEventListener('click', () => {
  cy?.fit(undefined, 24);
});

layoutButton.addEventListener('click', () => {
  currentLayoutMode = currentLayoutMode === 'vertical' ? 'force' : 'vertical';
  layoutButton.textContent =
    currentLayoutMode === 'vertical' ? 'Layout: Top to Bottom' : 'Layout: Force Directed';
  applyLayout();
});

maxDepthSlider.addEventListener('input', () => {
  maxDepthValue.textContent = maxDepthSlider.value;
  recomputeFlows();
});

moduleFilter.addEventListener('change', () => {
  recomputeFlows();
});

openSourceButton.addEventListener('click', () => {
  if (selectedEdgeId) {
    const edge = edgeCatalog.get(selectedEdgeId);
    const sourceNode = edge ? nodeCatalog.get(edge.source) : undefined;
    if (edge && sourceNode && sourceNode.filePath && typeof edge.metadata?.line === 'number') {
      vscode.postMessage({ type: 'navigateToEdge', edgeId: edge.id, filePath: sourceNode.filePath, line: edge.metadata.line });
      return;
    }
  }

  if (!selectedNodeId) {
    return;
  }

  const node = nodeCatalog.get(selectedNodeId);
  if (!node || !node.filePath || typeof node.line !== 'number') {
    return;
  }

  vscode.postMessage({ type: 'navigateToNode', nodeId: node.id });
});

window.addEventListener('resize', () => {
  if (!cy) {
    return;
  }

  cy.resize();
  cy.fit(undefined, 24);
});

window.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;

  switch (message.type) {
    case 'graphData':
      consumeGraphData(message.payload);
      break;
    case 'graphError':
      statusText.textContent = `Error: ${message.message}`;
      break;
    default:
      break;
  }
});

vscode.postMessage({ type: 'ready' });

function consumeGraphData(graphData: GraphData): void {
  latestGraphData = graphData;
  rebuildCatalogs(graphData);
  renderGraph(graphData);
  populateModuleFilter(graphData.nodes);
  recomputeFlows();

  statusText.textContent = `Loaded ${graphData.nodes.length} nodes and ${graphData.edges.length} edges from ${graphData.meta.workspaceName}`;
}

function rebuildCatalogs(graphData: GraphData): void {
  nodeCatalog.clear();
  edgeCatalog.clear();

  for (const node of graphData.nodes) {
    nodeCatalog.set(node.id, node);
  }

  for (const edge of graphData.edges) {
    edgeCatalog.set(edge.id, edge);
  }
}

function renderGraph(graphData: GraphData): void {
  const elements = buildCytoscapeElements(graphData);

  if (cy) {
    cy.destroy();
  }

  cy = cytoscape({
    container: graphContainer,
    elements,
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          'text-valign': 'center',
          'text-halign': 'center',
          'font-size': '11px',
          'background-color': '#4f46e5',
          color: '#f8fafc',
          'text-wrap': 'wrap',
          'text-max-width': '120px',
          width: '26px',
          height: '26px',
          'overlay-padding': '6px'
        }
      },
      {
        selector: 'node[type = "module"]',
        style: {
          shape: 'round-rectangle',
          width: '40px',
          height: '28px',
          'background-color': '#0f766e'
        }
      },
      {
        selector: 'node[type = "class"]',
        style: {
          shape: 'hexagon',
          'background-color': '#b45309'
        }
      },
      {
        selector: 'node[type = "function"]',
        style: {
          shape: 'ellipse',
          'background-color': '#2563eb'
        }
      },
      {
        selector: 'edge',
        style: {
          width: 2,
          'curve-style': 'bezier',
          'line-color': '#64748b',
          'target-arrow-color': '#64748b',
          'target-arrow-shape': 'triangle',
          opacity: 0.9
        }
      },
      {
        selector: 'edge[type = "dependency"]',
        style: {
          'line-style': 'dashed',
          'line-color': '#475569',
          'target-arrow-color': '#475569'
        }
      },
      {
        selector: '.is-dim',
        style: {
          opacity: 0.12
        }
      },
      {
        selector: '.is-flow-node',
        style: {
          opacity: 1,
          'border-color': '#fbbf24',
          'border-width': 2
        }
      },
      {
        selector: '.is-flow-edge',
        style: {
          opacity: 1,
          width: 3,
          'line-color': '#f59e0b',
          'target-arrow-color': '#f59e0b'
        }
      },
      {
        selector: '.is-focus-node',
        style: {
          opacity: 1,
          'border-color': '#06b6d4',
          'border-width': 2
        }
      },
      {
        selector: '.is-focus-edge',
        style: {
          opacity: 1,
          width: 3,
          'line-color': '#0891b2',
          'target-arrow-color': '#0891b2'
        }
      },
      {
        selector: '.is-selected-node',
        style: {
          'border-color': '#ef4444',
          'border-width': 3
        }
      },
      {
        selector: '.is-selected-edge',
        style: {
          'line-color': '#ef4444',
          'target-arrow-color': '#ef4444',
          width: 4
        }
      }
    ],
    layout: createLayoutOptions(currentLayoutMode)
  });

  cy.on('tap', 'node', (event) => {
    const nodeId = event.target.id();
    if (selectedNodeId === nodeId) {
      // Tapping the same node again exits focus mode
      selectedNodeId = undefined;
      updateNodeInspector(undefined);
    } else {
      selectedNodeId = nodeId;
      selectedEdgeId = undefined;
      updateNodeInspector(nodeId);
    }
    updateOpenSourceButtonState();
    applyFlowHighlight();
  });

  cy.on('tap', 'edge', (event) => {
    const edgeId = event.target.id();
    if (selectedEdgeId === edgeId) {
      selectedEdgeId = undefined;
      updateNodeInspector(undefined);
    } else {
      selectedEdgeId = edgeId;
      selectedNodeId = undefined;
      updateEdgeInspector(edgeId);
    }
    updateOpenSourceButtonState();
    applyFlowHighlight();
  });

  cy.on('tap', (event) => {
    if (event.target !== cy) {
      return;
    }

    selectedNodeId = undefined;
    selectedEdgeId = undefined;
    updateNodeInspector(undefined);
    updateOpenSourceButtonState();
    applyFlowHighlight();
  });

  cy.fit(undefined, 24);
  applyFlowHighlight();
}

function applyLayout(): void {
  if (!cy) {
    return;
  }

  cy.layout(createLayoutOptions(currentLayoutMode)).run();
}

function createLayoutOptions(layoutMode: LayoutMode): cytoscape.LayoutOptions {
  if (layoutMode === 'vertical') {
    return {
      name: 'breadthfirst',
      directed: true,
      fit: true,
      padding: 24,
      spacingFactor: 1.3,
      animate: false
    };
  }

  return {
    name: 'cose',
    fit: true,
    padding: 24,
    animate: false,
    nodeRepulsion: 7500,
    idealEdgeLength: 90
  };
}

function buildCytoscapeElements(graphData: GraphData): cytoscape.ElementDefinition[] {
  const nodes = graphData.nodes;
  const nodeIds = new Set(nodes.map((node) => node.id));

  const preferredEdges = graphData.edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && (edge.type === 'call' || edge.type === 'dependency')
  );
  const fallbackEdges = graphData.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const edges = preferredEdges.length > 0 ? preferredEdges : fallbackEdges;

  const nodeElements = nodes.map<cytoscape.ElementDefinition>((node) => ({
    data: {
      id: node.id,
      label: node.name,
      type: node.type
    }
  }));

  const edgeElements = edges.map<cytoscape.ElementDefinition>((edge) => ({
    data: {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.type
    }
  }));

  return [...nodeElements, ...edgeElements];
}

function populateModuleFilter(nodes: GraphNode[]): void {
  const previousSelection = moduleFilter.value;
  moduleFilter.innerHTML = '';

  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = 'All modules';
  moduleFilter.appendChild(allOption);

  const moduleNodes = nodes
    .filter((node) => node.type === 'module')
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const moduleNode of moduleNodes) {
    const option = document.createElement('option');
    option.value = moduleNode.id;
    option.textContent = moduleNode.name;
    moduleFilter.appendChild(option);
  }

  const hasPrevious = Array.from(moduleFilter.options).some((option) => option.value === previousSelection);
  moduleFilter.value = hasPrevious ? previousSelection : 'all';
}

function recomputeFlows(): void {
  if (!latestGraphData) {
    return;
  }

  const maxDepth = Number.parseInt(maxDepthSlider.value, 10) || 8;
  const moduleId = moduleFilter.value || 'all';
  flows = extractTopToBottomFlows(latestGraphData, maxDepth, moduleId);

  if (!selectedFlowId || !flows.some((flow) => flow.id === selectedFlowId)) {
    selectedFlowId = flows[0]?.id;
  }

  renderFlowList();
  renderFlowSteps(getSelectedFlow());
  applyFlowHighlight();
  flowMeta.textContent = `${flows.length} flow${flows.length === 1 ? '' : 's'} discovered`;
}

function extractTopToBottomFlows(graphData: GraphData, maxDepth: number, moduleId: string): FlowDefinition[] {
  const baseNodes = graphData.nodes;
  const baseNodeIds = new Set(baseNodes.map((node) => node.id));
  const baseEdges = resolveFlowEdges(graphData.edges, baseNodeIds);

  const scopedNodeIds = new Set<string>();
  if (moduleId !== 'all') {
    for (const node of baseNodes) {
      const nodeModuleId = getModuleNodeId(node);
      if (node.id === moduleId || nodeModuleId === moduleId) {
        scopedNodeIds.add(node.id);
      }
    }
  }

  const nodes =
    moduleId === 'all' ? baseNodes : baseNodes.filter((node) => scopedNodeIds.has(node.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = baseEdges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

  const outgoing = new Map<string, GraphEdge[]>();
  const incomingCount = new Map<string, number>();

  for (const node of nodes) {
    outgoing.set(node.id, []);
    incomingCount.set(node.id, 0);
  }

  for (const edge of edges) {
    const next = outgoing.get(edge.source);
    if (next) {
      next.push(edge);
    }

    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
  }

  let roots = nodes
    .filter((node) => (incomingCount.get(node.id) ?? 0) === 0 && (outgoing.get(node.id)?.length ?? 0) > 0)
    .map((node) => node.id);

  if (roots.length === 0) {
    roots = nodes
      .filter((node) => (outgoing.get(node.id)?.length ?? 0) > 0)
      .map((node) => node.id);
  }

  const dedupe = new Set<string>();
  const result: FlowDefinition[] = [];
  const maxFlows = 250;

  const dfs = (currentNodeId: string, pathNodeIds: string[], pathEdgeIds: string[], visited: Set<string>): void => {
    if (result.length >= maxFlows) {
      return;
    }

    const nextEdges = outgoing.get(currentNodeId) ?? [];
    const reachedLimit = pathEdgeIds.length >= maxDepth;

    if (nextEdges.length === 0 || reachedLimit) {
      if (pathNodeIds.length >= 2) {
        const key = pathNodeIds.join('>');
        if (!dedupe.has(key)) {
          dedupe.add(key);
          const label = pathNodeIds
            .map((nodeId) => nodeCatalog.get(nodeId)?.name ?? nodeId)
            .join(' -> ');
          result.push({
            id: `flow-${result.length + 1}`,
            nodeIds: [...pathNodeIds],
            edgeIds: [...pathEdgeIds],
            label
          });
        }
      }
      return;
    }

    for (const edge of nextEdges) {
      if (visited.has(edge.target)) {
        continue;
      }

      visited.add(edge.target);
      pathNodeIds.push(edge.target);
      pathEdgeIds.push(edge.id);
      dfs(edge.target, pathNodeIds, pathEdgeIds, visited);
      pathNodeIds.pop();
      pathEdgeIds.pop();
      visited.delete(edge.target);
    }
  };

  for (const root of roots) {
    const visited = new Set<string>([root]);
    dfs(root, [root], [], visited);
  }

  return result.sort((a, b) => b.nodeIds.length - a.nodeIds.length || a.label.localeCompare(b.label));
}

function resolveFlowEdges(edges: GraphEdge[], nodeIds: Set<string>): GraphEdge[] {
  const preferred = edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && (edge.type === 'call' || edge.type === 'dependency')
  );

  if (preferred.length > 0) {
    return preferred;
  }

  const fallback = edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.type !== 'contains'
  );

  return fallback.length > 0 ? fallback : edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
}

function getModuleNodeId(node: GraphNode): string | undefined {
  if (node.type === 'module') {
    return node.id;
  }

  const moduleNodeId = node.metadata?.moduleNodeId;
  return typeof moduleNodeId === 'string' ? moduleNodeId : undefined;
}

function renderFlowList(): void {
  flowList.innerHTML = '';

  if (flows.length === 0) {
    const item = document.createElement('li');
    item.className = 'empty-state';
    item.textContent = 'No directed flow paths found for this scope';
    flowList.appendChild(item);
    return;
  }

  flows.forEach((flow, index) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'flow-item';

    if (flow.id === selectedFlowId) {
      button.classList.add('is-active');
    }

    button.textContent = `${index + 1}. ${flow.label}`;
    button.addEventListener('click', () => {
      selectedFlowId = flow.id;
      selectedNodeId = flow.nodeIds[0];
      renderFlowList();
      renderFlowSteps(flow);
      updateNodeInspector(selectedNodeId);
      updateOpenSourceButtonState();
      applyFlowHighlight();
    });

    item.appendChild(button);
    flowList.appendChild(item);
  });
}

function renderFlowSteps(flow: FlowDefinition | undefined): void {
  flowSteps.innerHTML = '';

  if (!flow) {
    const item = document.createElement('li');
    item.className = 'empty-state';
    item.textContent = 'Select a flow to inspect step-by-step';
    flowSteps.appendChild(item);
    return;
  }

  for (const nodeId of flow.nodeIds) {
    const node = nodeCatalog.get(nodeId);
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'step-item';
    button.textContent = node ? `${node.name} (${node.type})` : nodeId;

    button.addEventListener('click', () => {
      selectedNodeId = nodeId;
      selectedEdgeId = undefined;
      updateNodeInspector(nodeId);
      updateOpenSourceButtonState();
      applyFlowHighlight();
      const target = cy?.getElementById(nodeId);
      if (target && target.nonempty()) {
        cy?.animate({
          center: { eles: target },
          duration: 180
        });
      }
    });

    item.appendChild(button);
    flowSteps.appendChild(item);
  }
}

function applyFlowHighlight(): void {
  if (!cy) {
    return;
  }

  const cyInstance = cy;

  const selectedFlow = getSelectedFlow();
  const flowNodeIds = new Set(selectedFlow?.nodeIds ?? []);
  const flowEdgeIds = new Set(selectedFlow?.edgeIds ?? []);

  cyInstance.batch(() => {
    cyInstance.elements().removeClass('is-dim is-flow-node is-flow-edge is-selected-node is-selected-edge is-focus-node is-focus-edge');

    const hasSelectedNode = !!selectedNodeId;
    const hasSelectedEdge = !!selectedEdgeId;
    const hasSelectedFlow = !!selectedFlow;

    if (hasSelectedNode && selectedNodeId) {
      // Focus Mode: Highlight neighborhood
      const focusElement = cyInstance.getElementById(selectedNodeId);
      if (focusElement.nonempty()) {
        const incomers = focusElement.incomers();
        const outgoers = focusElement.outgoers();
        const neighborhood = focusElement.union(incomers).union(outgoers);

        cyInstance.elements().forEach((ele) => {
          if (neighborhood.has(ele)) {
            if (ele.isNode()) ele.addClass('is-focus-node');
            if (ele.isEdge()) ele.addClass('is-focus-edge');
          } else {
            ele.addClass('is-dim');
          }
        });

        focusElement.addClass('is-selected-node');
      }
    } else if (hasSelectedEdge && selectedEdgeId) {
      const selectedElement = cyInstance.getElementById(selectedEdgeId);
      if (selectedElement.nonempty()) {
        const sourceNode = cyInstance.getElementById(selectedElement.data('source'));
        const targetNode = cyInstance.getElementById(selectedElement.data('target'));
        const edgeNeighborhood = selectedElement.union(sourceNode).union(targetNode);

        cyInstance.elements().forEach((ele) => {
          if (edgeNeighborhood.has(ele)) {
            if (ele.isNode()) ele.addClass('is-focus-node');
            if (ele.isEdge()) ele.addClass('is-focus-edge');
          } else {
            ele.addClass('is-dim');
          }
        });

        selectedElement.addClass('is-selected-edge');
      }
    } else if (hasSelectedFlow) {
      cyInstance.nodes().forEach((node) => {
        if (flowNodeIds.has(node.id())) {
          node.addClass('is-flow-node');
        } else {
          node.addClass('is-dim');
        }
      });

      cyInstance.edges().forEach((edge) => {
        if (flowEdgeIds.has(edge.id())) {
          edge.addClass('is-flow-edge');
        } else {
          edge.addClass('is-dim');
        }
      });
    }
  });
}

function updateEdgeInspector(edgeId: string | undefined): void {
  if (!edgeId) {
    nodeInspector.textContent = 'Select a node or edge to inspect';
    return;
  }

  const edge = edgeCatalog.get(edgeId);
  if (!edge) {
    nodeInspector.textContent = 'Edge is no longer available in the current graph';
    return;
  }

  const sourceNode = nodeCatalog.get(edge.source);
  const targetNode = nodeCatalog.get(edge.target);

  const location = sourceNode?.filePath && typeof edge.metadata?.line === 'number' 
    ? `${sourceNode.filePath}:${edge.metadata.line}` 
    : 'N/A';

  nodeInspector.textContent = [
    `Type: ${edge.type}`,
    `Source: ${sourceNode?.name ?? edge.source}`,
    `Target: ${targetNode?.name ?? edge.target}`,
    `Location: ${location}`,
    `Reason: ${edge.metadata?.reason ?? 'N/A'}`
  ].join('\n');
}

function updateNodeInspector(nodeId: string | undefined): void {
  if (!nodeId) {
    nodeInspector.textContent = 'Select a node to inspect';
    return;
  }

  const node = nodeCatalog.get(nodeId);
  if (!node) {
    nodeInspector.textContent = 'Node is no longer available in the current graph';
    return;
  }

  const calledBy: string[] = [];
  const calls: string[] = [];

  for (const edge of edgeCatalog.values()) {
    if (edge.target === node.id) {
      const sourceNode = nodeCatalog.get(edge.source);
      if (sourceNode) calledBy.push(sourceNode.name);
    }
    if (edge.source === node.id) {
      const targetNode = nodeCatalog.get(edge.target);
      if (targetNode) calls.push(targetNode.name);
    }
  }

  const location = node.filePath && typeof node.line === 'number' ? `${node.filePath}:${node.line}` : 'N/A';

  const lines: string[] = [
    `Name: ${node.name}`,
    `Type: ${node.type}`,
    `Location: ${location}`,
    '',
    `← Called by (${calledBy.length}):`,
    ...( calledBy.length > 0 ? calledBy.map((n) => `   ${n}`) : ['   (none)']),
    '',
    `→ Calls (${calls.length}):`,
    ...( calls.length > 0 ? calls.map((n) => `   ${n}`) : ['   (none)'])
  ];

  nodeInspector.textContent = lines.join('\n');
}

function updateOpenSourceButtonState(): void {
  if (selectedEdgeId) {
    const edge = edgeCatalog.get(selectedEdgeId);
    const sourceNode = edge ? nodeCatalog.get(edge.source) : undefined;
    openSourceButton.disabled = !edge || !sourceNode || !sourceNode.filePath || typeof edge.metadata?.line !== 'number';
    return;
  }

  if (!selectedNodeId) {
    openSourceButton.disabled = true;
    return;
  }

  const node = nodeCatalog.get(selectedNodeId);
  openSourceButton.disabled = !node || !node.filePath || typeof node.line !== 'number';
}

function getSelectedFlow(): FlowDefinition | undefined {
  if (!selectedFlowId) {
    return undefined;
  }

  return flows.find((flow) => flow.id === selectedFlowId);
}

function getRequiredElement<TElement extends HTMLElement>(selector: string): TElement {
  const element = document.querySelector<TElement>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }

  return element;
}
