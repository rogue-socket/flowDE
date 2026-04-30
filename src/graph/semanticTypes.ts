import { GraphEdge, GraphNode } from './schema';

/**
 * Symbol discovered from a function definition.
 */
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

/**
 * Symbol discovered from a class definition.
 */
export interface IndexedClassSymbol {
  id: string;
  name: string;
  filePath: string;
  line: number;
  moduleNodeId: string;
  moduleName: string;
}

/**
 * Indexed call-site relationship discovered in function bodies.
 */
export interface IndexedCallReference {
  sourceFunctionId: string;
  sourceModuleId: string;
  sourceModuleName: string;
  calleeName: string;
  calleePath: string[];
  line?: number;
}

/**
 * Symbol discovered from a variable assignment.
 */
export interface IndexedVariableSymbol {
  id: string;
  name: string;
  filePath: string;
  line: number;
  moduleNodeId: string;
  moduleName: string;
  functionId?: string;
}

/**
 * Data-flow reference linking a variable assignment to its source call expression.
 */
export interface IndexedDataFlowReference {
  variableId: string;
  calleeName: string;
  calleePath: string[];
  kind: 'assignment' | 'parameter' | 'return';
  line: number;
  sourceFunctionId?: string;
  moduleNodeId: string;
  moduleName: string;
}

/**
 * Import alias mapping used for relation disambiguation.
 */
export interface ImportBinding {
  alias: string;
  kind: 'module' | 'symbol';
  moduleName: string;
  symbolName?: string;
}

/**
 * Complete parsed module payload produced by the indexer.
 */
export interface IndexedModule {
  relativePath: string;
  moduleName: string;
  moduleNode: GraphNode;
  classes: IndexedClassSymbol[];
  functions: IndexedFunctionSymbol[];
  callRefs: IndexedCallReference[];
  variables: IndexedVariableSymbol[];
  dataFlowRefs: IndexedDataFlowReference[];
  dependencies: string[];
  importBindings: ImportBinding[];
  warning?: string;
}

/**
 * Aggregate workspace indexing result including parse/cache diagnostics.
 */
export interface IndexingResult {
  modules: IndexedModule[];
  fileCount: number;
  stats: {
    parseWarnings: string[];
    cacheHits: number;
    cacheMisses: number;
  };
}

/**
 * Summary counters from relation resolution.
 */
export interface ResolutionDiagnostics {
  resolvedCalls: number;
  unresolvedCalls: number;
  ambiguousCalls: number;
  classUsageEdges: number;
  indexedClasses: number;
}

/**
 * Final resolved graph artifacts and diagnostics.
 */
export interface ResolutionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: ResolutionDiagnostics;
}
