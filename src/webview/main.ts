import cytoscape = require('cytoscape');

declare function acquireVsCodeApi(): {
  postMessage: (message: unknown) => void;
};

type GraphNodeType = 'function' | 'variable' | 'module';
type GraphEdgeType = 'call' | 'dependency';

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

const vscode = acquireVsCodeApi();
const graphContainer = getRequiredElement<HTMLElement>('#graph-canvas');
const statusText = getRequiredElement<HTMLElement>('#status');
const refreshButton = getRequiredElement<HTMLButtonElement>('#refresh-btn');

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
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'target-arrow-color': '#a8b0b8',
        'arrow-scale': 0.7,
        opacity: 0.85
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

  if (graphData.nodes.length > 0) {
    graph.layout({
      name: 'cose',
      animate: false,
      nodeRepulsion: 320000,
      idealEdgeLength: 110,
      fit: true,
      padding: 30
    }).run();
  }

  const warningSuffix =
    graphData.meta.parseWarnings.length > 0
      ? ` | warnings: ${graphData.meta.parseWarnings.length}`
      : '';

  statusText.textContent = `Workspace ${graphData.meta.workspaceName}: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges from ${graphData.meta.fileCount} Python files${warningSuffix}`;
}

function formatNodeLabel(node: GraphNode): string {
  if (node.type === 'module') {
    return `Module\\n${node.name}`;
  }

  if (node.type === 'function') {
    return `Function\\n${node.name}`;
  }

  return node.name;
}

function getRequiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`FlowDE webview failed to resolve required element: ${selector}`);
  }

  return element;
}
