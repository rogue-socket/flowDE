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
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: {
    workspaceName: string;
    generatedAt: string;
    fileCount: number;
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

const vscode = acquireVsCodeApi();
const graphContainer = getRequiredElement<HTMLElement>('#graph-canvas');
const statusText = getRequiredElement<HTMLElement>('#status');
const layoutButton = getRequiredElement<HTMLButtonElement>('#layout-btn');
const refreshButton = getRequiredElement<HTMLButtonElement>('#refresh-btn');
let currentLayoutMode: LayoutMode = 'clustered';
let latestGraphData: GraphData | undefined;

const graph = cytoscape({
  container: graphContainer,
  elements: [],
  layout: {
    name: 'grid'
  },
  wheelSensitivity: 0.15,
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
    applyLayout(latestGraphData);
  }
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

vscode.postMessage({ type: 'ready' });

function renderGraph(graphData: GraphData): void {
  latestGraphData = graphData;

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

  applyLayout(graphData);

  const warningSuffix =
    graphData.meta.parseWarnings.length > 0
      ? ` | warnings: ${graphData.meta.parseWarnings.length}`
      : '';

  statusText.textContent = `Workspace ${graphData.meta.workspaceName}: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges from ${graphData.meta.fileCount} Python files${warningSuffix}`;
}

function applyLayout(graphData: GraphData): void {
  if (graphData.nodes.length === 0) {
    return;
  }

  if (currentLayoutMode === 'clustered') {
    applyClusteredLayout(graphData);
    return;
  }

  graph.layout({
    name: 'cose',
    animate: false,
    nodeRepulsion: 240000,
    idealEdgeLength: 100,
    fit: true,
    padding: 40
  }).run();
}

function applyClusteredLayout(graphData: GraphData): void {
  const positions = computeClusteredPositions(graphData);
  const positionMap: Record<string, Point> = {};
  for (const [id, point] of positions.entries()) {
    positionMap[id] = point;
  }

  graph.layout({
    name: 'preset',
    positions: positionMap,
    animate: false,
    fit: true,
    padding: 70
  }).run();
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

function getRequiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`FlowDE webview failed to resolve required element: ${selector}`);
  }

  return element;
}
