import * as vscode from 'vscode';
import { parser } from '@lezer/python';
import { SyntaxNode } from '@lezer/common';
import { GraphData, GraphEdge, GraphNode } from './schema';

const PYTHON_EXCLUDE_GLOB = '**/{.git,node_modules,.venv,venv,__pycache__,dist}/**';

interface FunctionSymbol {
  id: string;
  name: string;
  filePath: string;
  line: number;
  moduleNodeId: string;
}

interface CallReference {
  sourceFunctionId: string;
  sourceModuleId: string;
  calleeName: string;
}

interface FileParseResult {
  moduleNode: GraphNode;
  functions: FunctionSymbol[];
  callRefs: CallReference[];
  dependencies: string[];
  warning?: string;
}

export class PythonWorkspaceGraphBuilder {
  public async buildGraph(workspaceFolder: vscode.WorkspaceFolder): Promise<GraphData> {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceFolder, '**/*.py'),
      PYTHON_EXCLUDE_GLOB
    );

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const parseWarnings: string[] = [];
    const functionSymbols: FunctionSymbol[] = [];
    const callRefs: CallReference[] = [];
    const dependencyRecords: Array<{ sourceModuleId: string; dependency: string }> = [];
    const moduleNameToNodeId = new Map<string, string>();
    const externalModuleNodes = new Map<string, GraphNode>();

    for (const fileUri of files) {
      const relativePath = vscode.workspace.asRelativePath(fileUri, false);

      try {
        const content = await vscode.workspace.fs.readFile(fileUri);
        const source = Buffer.from(content).toString('utf8');
        const fileResult = this.parsePythonFile(relativePath, source);

        nodes.push(fileResult.moduleNode);
        moduleNameToNodeId.set(fileResult.moduleNode.name, fileResult.moduleNode.id);
        functionSymbols.push(...fileResult.functions);
        callRefs.push(...fileResult.callRefs);

        for (const dependency of fileResult.dependencies) {
          dependencyRecords.push({
            sourceModuleId: fileResult.moduleNode.id,
            dependency
          });
        }

        if (fileResult.warning) {
          parseWarnings.push(fileResult.warning);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        parseWarnings.push(`Failed to parse ${relativePath}: ${errorMessage}`);
      }
    }

    nodes.push(
      ...functionSymbols.map((symbol) => ({
        id: symbol.id,
        type: 'function' as const,
        name: symbol.name,
        filePath: symbol.filePath,
        line: symbol.line,
        metadata: {
          moduleNodeId: symbol.moduleNodeId
        }
      }))
    );

    const functionSymbolsByName = new Map<string, FunctionSymbol[]>();
    for (const symbol of functionSymbols) {
      const list = functionSymbolsByName.get(symbol.name) ?? [];
      list.push(symbol);
      functionSymbolsByName.set(symbol.name, list);
    }

    const uniqueEdgeIds = new Set<string>();

    for (const callRef of callRefs) {
      const targetFunctionId = this.resolveCallTarget(callRef, functionSymbolsByName);
      if (!targetFunctionId) {
        continue;
      }

      const edgeId = `edge:call:${callRef.sourceFunctionId}->${targetFunctionId}`;
      if (uniqueEdgeIds.has(edgeId)) {
        continue;
      }

      uniqueEdgeIds.add(edgeId);
      edges.push({
        id: edgeId,
        source: callRef.sourceFunctionId,
        target: targetFunctionId,
        type: 'call'
      });
    }

    for (const record of dependencyRecords) {
      const moduleName = record.dependency;
      let targetModuleId = moduleNameToNodeId.get(moduleName);

      if (!targetModuleId) {
        const externalId = `module:external:${moduleName}`;
        targetModuleId = externalId;

        if (!externalModuleNodes.has(moduleName)) {
          const externalNode: GraphNode = {
            id: externalId,
            type: 'module',
            name: moduleName,
            metadata: { external: true }
          };
          externalModuleNodes.set(moduleName, externalNode);
        }
      }

      const edgeId = `edge:dependency:${record.sourceModuleId}->${targetModuleId}`;
      if (uniqueEdgeIds.has(edgeId)) {
        continue;
      }

      uniqueEdgeIds.add(edgeId);
      edges.push({
        id: edgeId,
        source: record.sourceModuleId,
        target: targetModuleId,
        type: 'dependency'
      });
    }

    nodes.push(...externalModuleNodes.values());

    return {
      nodes,
      edges,
      meta: {
        workspaceName: workspaceFolder.name,
        generatedAt: new Date().toISOString(),
        fileCount: files.length,
        parseWarnings
      }
    };
  }

  private parsePythonFile(relativePath: string, source: string): FileParseResult {
    const moduleName = this.moduleNameFromPath(relativePath);
    const moduleNodeId = `module:${relativePath}`;
    const moduleNode: GraphNode = {
      id: moduleNodeId,
      type: 'module',
      name: moduleName,
      filePath: relativePath,
      line: 1
    };

    const dependencies = this.extractDependencies(source);
    const parseArtifacts = this.collectFunctionsAndCalls(source, relativePath, moduleNodeId);

    return {
      moduleNode,
      functions: parseArtifacts.functions,
      callRefs: parseArtifacts.callRefs,
      dependencies,
      warning: parseArtifacts.warning
    };
  }

  private collectFunctionsAndCalls(
    source: string,
    relativePath: string,
    moduleNodeId: string
  ): { functions: FunctionSymbol[]; callRefs: CallReference[]; warning?: string } {
    const functions: FunctionSymbol[] = [];
    const callRefs: CallReference[] = [];

    try {
      const tree = parser.parse(source);
      const lineMap = this.buildLineStartMap(source);

      const walk = (node: SyntaxNode, activeFunctionId?: string): void => {
        let currentFunctionId = activeFunctionId;

        if (node.type.name === 'FunctionDefinition') {
          const nameNode = this.findFirstChildByType(node, 'VariableName');
          if (nameNode) {
            const functionName = source.slice(nameNode.from, nameNode.to);
            const line = this.positionToLine(lineMap, nameNode.from);
            const functionId = `function:${relativePath}:${functionName}:${line}`;

            functions.push({
              id: functionId,
              name: functionName,
              filePath: relativePath,
              line,
              moduleNodeId
            });

            currentFunctionId = functionId;
          }
        }

        if (node.type.name === 'CallExpression' && currentFunctionId) {
          const calleeName = this.extractCalleeName(node, source);
          if (calleeName) {
            callRefs.push({
              sourceFunctionId: currentFunctionId,
              sourceModuleId: moduleNodeId,
              calleeName
            });
          }
        }

        for (let child = node.firstChild; child; child = child.nextSibling) {
          walk(child, currentFunctionId);
        }
      };

      walk(tree.topNode);

      return { functions, callRefs };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        functions,
        callRefs,
        warning: `Parser fallback on ${relativePath}: ${errorMessage}`
      };
    }
  }

  private resolveCallTarget(
    callRef: CallReference,
    functionSymbolsByName: Map<string, FunctionSymbol[]>
  ): string | undefined {
    const candidates = functionSymbolsByName.get(callRef.calleeName);
    if (!candidates || candidates.length === 0) {
      return undefined;
    }

    const sameModuleCandidates = candidates.filter(
      (candidate) => candidate.moduleNodeId === callRef.sourceModuleId
    );

    if (sameModuleCandidates.length === 1) {
      return sameModuleCandidates[0].id;
    }

    if (candidates.length === 1) {
      return candidates[0].id;
    }

    return undefined;
  }

  private extractDependencies(source: string): string[] {
    const dependencies = new Set<string>();

    for (const match of source.matchAll(/^\s*import\s+([^\n#]+)/gm)) {
      const modules = match[1].split(',');
      for (const moduleChunk of modules) {
        const moduleName = moduleChunk.trim().split(/\s+as\s+/i)[0];
        const normalized = this.normalizeDependencyName(moduleName);
        if (normalized) {
          dependencies.add(normalized);
        }
      }
    }

    for (const match of source.matchAll(/^\s*from\s+([a-zA-Z_][\w\.]*)\s+import\s+/gm)) {
      const normalized = this.normalizeDependencyName(match[1]);
      if (normalized) {
        dependencies.add(normalized);
      }
    }

    return [...dependencies];
  }

  private normalizeDependencyName(name: string): string | undefined {
    const trimmed = name.trim();
    if (!trimmed || trimmed.startsWith('.')) {
      return undefined;
    }

    return trimmed;
  }

  private moduleNameFromPath(relativePath: string): string {
    const withoutExtension = relativePath.replace(/\.py$/, '');
    const dotted = withoutExtension.replace(/\//g, '.');
    if (dotted.endsWith('.__init__')) {
      return dotted.slice(0, -'.__init__'.length);
    }
    return dotted;
  }

  private findFirstChildByType(node: SyntaxNode, typeName: string): SyntaxNode | undefined {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.type.name === typeName) {
        return child;
      }
    }

    return undefined;
  }

  private extractCalleeName(node: SyntaxNode, source: string): string | undefined {
    let calleeNode: SyntaxNode | undefined;

    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.type.name === 'ArgList') {
        break;
      }
      calleeNode = child;
    }

    if (!calleeNode) {
      return undefined;
    }

    const calleeText = source.slice(calleeNode.from, calleeNode.to);
    const parts = calleeText.match(/[A-Za-z_][A-Za-z0-9_]*/g);
    if (!parts || parts.length === 0) {
      return undefined;
    }

    return parts[parts.length - 1];
  }

  private buildLineStartMap(source: string): number[] {
    const lineStarts = [0];
    for (let index = 0; index < source.length; index += 1) {
      if (source.charCodeAt(index) === 10) {
        lineStarts.push(index + 1);
      }
    }
    return lineStarts;
  }

  private positionToLine(lineStarts: number[], offset: number): number {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (lineStarts[mid] <= offset) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return Math.max(high + 1, 1);
  }
}
