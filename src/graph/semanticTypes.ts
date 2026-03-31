import { GraphEdge, GraphNode } from './schema';

export interface IndexedFunctionSymbol {
  id: string;
  name: string;
  filePath: string;
  line: number;
  moduleNodeId: string;
  moduleName: string;
  classNodeId?: string;
  className?: string;
}

export interface IndexedClassSymbol {
  id: string;
  name: string;
  filePath: string;
  line: number;
  moduleNodeId: string;
  moduleName: string;
}

export interface IndexedVariableSymbol {
  id: string;
  name: string;
  filePath: string;
  line: number;
  moduleNodeId: string;
  moduleName: string;
  functionNodeId?: string;
}

export interface IndexedDataFlowReference {
  sourceNodeId: string;
  targetNodeId: string;
  variableName?: string;
  reason: string;
}

export interface IndexedCallReference {
  sourceFunctionId: string;
  sourceModuleId: string;
  sourceModuleName: string;
  calleeName: string;
  calleePath: string[];
}

export interface ImportBinding {
  alias: string;
  kind: 'module' | 'symbol';
  moduleName: string;
  symbolName?: string;
}

export interface IndexedModule {
  relativePath: string;
  moduleName: string;
  moduleNode: GraphNode;
  classes: IndexedClassSymbol[];
  functions: IndexedFunctionSymbol[];
  variables: IndexedVariableSymbol[];
  callRefs: IndexedCallReference[];
  dataFlowRefs: IndexedDataFlowReference[];
  dependencies: string[];
  importBindings: ImportBinding[];
  warning?: string;
}

export interface IndexingResult {
  modules: IndexedModule[];
  fileCount: number;
  stats: {
    parseWarnings: string[];
    cacheHits: number;
    cacheMisses: number;
  };
}

export interface ResolutionDiagnostics {
  resolvedCalls: number;
  unresolvedCalls: number;
  ambiguousCalls: number;
  classUsageEdges: number;
  dataFlowEdges: number;
  indexedClasses: number;
  indexedVariables: number;
}

export interface ResolutionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: ResolutionDiagnostics;
}
