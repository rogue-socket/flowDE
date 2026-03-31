/**
 * Shared graph contracts exchanged between extension host and webview.
 */
export type GraphLayer = 'structural' | 'dependency' | 'dataflow' | 'execution';
export type GraphNodeType = 'function' | 'variable' | 'module' | 'class';
export type GraphNodeRole =
  | 'container'
  | 'callable'
  | 'type'
  | 'state'
  | 'transform'
  | 'external';
export type GraphEdgeType =
  | 'call'
  | 'dependency'
  | 'contains'
  | 'class-usage'
  | 'dataflow'
  | 'execution-path';
export type GraphEdgeProvenance = 'containment' | 'ast' | 'import-map' | 'heuristic';

/**
 * Optional metadata attached to graph nodes for feature-specific rendering and lookup.
 */
export interface GraphNodeMetadata {
  moduleNodeId?: string;
  external?: boolean;
  unresolved?: boolean;
  [key: string]: unknown;
}

/**
 * Optional metadata attached to edges to describe confidence and derivation strategy.
 */
export interface GraphEdgeMetadata {
  confidence?: number;
  provenance?: GraphEdgeProvenance;
  reason?: string;
  [key: string]: unknown;
}

/**
 * Diagnostics emitted by the graph pipeline and shown in the webview status UI.
 */
export interface GraphDiagnostics {
  resolvedCalls: number;
  unresolvedCalls: number;
  ambiguousCalls: number;
  classUsageEdges: number;
  dataFlowEdges: number;
  indexedClasses: number;
  indexedVariables: number;
  parserCacheHits: number;
  parserCacheMisses: number;
}

/**
 * Per-layer counts used for default visibility and summary displays.
 */
export interface GraphLayerStats {
  nodes: number;
  edges: number;
  visibleByDefault: boolean;
}

/**
 * Canonical node representation consumed by the graph renderer.
 */
export interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  layers: GraphLayer[];
  roles: GraphNodeRole[];
  filePath?: string;
  line?: number;
  moduleName?: string;
  metadata?: GraphNodeMetadata;
}

/**
 * Canonical directed edge representation consumed by the graph renderer.
 */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  layer: GraphLayer;
  metadata?: GraphEdgeMetadata;
}

/**
 * Fully materialized graph payload for a workspace snapshot.
 */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: {
    workspaceName: string;
    generatedAt: string;
    fileCount: number;
    engineVersion: string;
    layerStats: Record<GraphLayer, GraphLayerStats>;
    diagnostics: GraphDiagnostics;
    parseWarnings: string[];
  };
}
