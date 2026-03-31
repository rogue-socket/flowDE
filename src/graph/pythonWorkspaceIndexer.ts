import * as vscode from 'vscode';
import { parser } from '@lezer/python';
import { SyntaxNode } from '@lezer/common';
import { GraphNode } from './schema';
import {
  IndexedClassSymbol,
  ImportBinding,
  IndexedCallReference,
  IndexedDataFlowReference,
  IndexedFunctionSymbol,
  IndexedModule,
  IndexedVariableSymbol,
  IndexingResult
} from './semanticTypes';
import { WorkspaceGraphCache } from './workspaceGraphCache';

const PYTHON_EXCLUDE_GLOB = '**/{.git,node_modules,.venv,venv,__pycache__,dist}/**';
const PYTHON_IDENTIFIERS_TO_SKIP = new Set([
  'and',
  'as',
  'assert',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'false',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'none',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'true',
  'try',
  'while',
  'with',
  'yield'
]);

export class PythonWorkspaceIndexer {
  constructor(private readonly cache: WorkspaceGraphCache) {}

  public async indexWorkspace(workspaceFolder: vscode.WorkspaceFolder): Promise<IndexingResult> {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceFolder, '**/*.py'),
      PYTHON_EXCLUDE_GLOB
    );

    const modules: IndexedModule[] = [];
    const parseWarnings: string[] = [];
    const validRelativePaths = new Set<string>();
    let cacheHits = 0;
    let cacheMisses = 0;

    for (const fileUri of files) {
      const relativePath = vscode.workspace.asRelativePath(fileUri, false);
      validRelativePaths.add(relativePath);

      try {
        const stats = await vscode.workspace.fs.stat(fileUri);
        const version = `${stats.mtime}:${stats.size}`;
        const cachedModule = this.cache.get(relativePath, version);

        if (cachedModule) {
          cacheHits += 1;
          modules.push(cachedModule);
          if (cachedModule.warning) {
            parseWarnings.push(cachedModule.warning);
          }
          continue;
        }

        cacheMisses += 1;
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const source = Buffer.from(bytes).toString('utf8');
        const module = this.indexPythonFile(relativePath, source);
        this.cache.set(relativePath, version, module);

        modules.push(module);
        if (module.warning) {
          parseWarnings.push(module.warning);
        }
      } catch (error) {
        cacheMisses += 1;
        const errorMessage = error instanceof Error ? error.message : String(error);
        parseWarnings.push(`Failed to parse ${relativePath}: ${errorMessage}`);
        modules.push(this.createFallbackModule(relativePath));
      }
    }

    this.cache.sweep(validRelativePaths);

    return {
      modules,
      fileCount: files.length,
      stats: {
        parseWarnings,
        cacheHits,
        cacheMisses
      }
    };
  }

  private indexPythonFile(relativePath: string, source: string): IndexedModule {
    const moduleName = this.moduleNameFromPath(relativePath);
    const moduleNodeId = `module:${relativePath}`;
    const moduleNode: GraphNode = {
      id: moduleNodeId,
      type: 'module',
      name: moduleName,
      layers: ['structural', 'dependency', 'dataflow'],
      roles: ['container'],
      filePath: relativePath,
      line: 1
    };

    const importArtifacts = this.extractImportArtifacts(source, moduleName, relativePath);
    const parseArtifacts = this.collectSymbolsAndRelations(source, relativePath, moduleNodeId, moduleName);

    return {
      relativePath,
      moduleName,
      moduleNode,
      classes: parseArtifacts.classes,
      functions: parseArtifacts.functions,
      variables: parseArtifacts.variables,
      callRefs: parseArtifacts.callRefs,
      dataFlowRefs: parseArtifacts.dataFlowRefs,
      dependencies: importArtifacts.dependencies,
      importBindings: importArtifacts.importBindings,
      warning: parseArtifacts.warning
    };
  }

  private createFallbackModule(relativePath: string): IndexedModule {
    const moduleName = this.moduleNameFromPath(relativePath);
    return {
      relativePath,
      moduleName,
      moduleNode: {
        id: `module:${relativePath}`,
        type: 'module',
        name: moduleName,
        layers: ['structural', 'dependency', 'dataflow'],
        roles: ['container'],
        filePath: relativePath,
        line: 1
      },
      classes: [],
      functions: [],
      variables: [],
      callRefs: [],
      dataFlowRefs: [],
      dependencies: [],
      importBindings: []
    };
  }

  private collectSymbolsAndRelations(
    source: string,
    relativePath: string,
    moduleNodeId: string,
    moduleName: string
  ): {
    classes: IndexedClassSymbol[];
    functions: IndexedFunctionSymbol[];
    variables: IndexedVariableSymbol[];
    callRefs: IndexedCallReference[];
    dataFlowRefs: IndexedDataFlowReference[];
    warning?: string;
  } {
    const classes: IndexedClassSymbol[] = [];
    const functions: IndexedFunctionSymbol[] = [];
    const variables: IndexedVariableSymbol[] = [];
    const callRefs: IndexedCallReference[] = [];
    const dataFlowRefs: IndexedDataFlowReference[] = [];
    const variableByScopeAndName = new Map<string, IndexedVariableSymbol>();

    const ensureScopedVariable = (
      name: string,
      line: number,
      functionNodeId?: string
    ): IndexedVariableSymbol => {
      const scopeKey = `${functionNodeId ?? moduleNodeId}::${name}`;
      const existing = variableByScopeAndName.get(scopeKey);
      if (existing) {
        return existing;
      }

      const symbol: IndexedVariableSymbol = {
        id: `variable:${relativePath}:${functionNodeId ?? 'module'}:${name}`,
        name,
        filePath: relativePath,
        line,
        moduleNodeId,
        moduleName,
        functionNodeId
      };

      variableByScopeAndName.set(scopeKey, symbol);
      variables.push(symbol);
      return symbol;
    };

    try {
      const tree = parser.parse(source);
      const lineMap = this.buildLineStartMap(source);

      const walk = (
        node: SyntaxNode,
        activeFunctionId?: string,
        activeClass?: IndexedClassSymbol
      ): void => {
        let currentFunctionId = activeFunctionId;
        let currentClass = activeClass;

        if (node.type.name === 'ClassDefinition') {
          const classNameNode = this.findFirstChildByType(node, 'VariableName');
          if (classNameNode) {
            const className = source.slice(classNameNode.from, classNameNode.to);
            const line = this.positionToLine(lineMap, classNameNode.from);
            const classId = `class:${relativePath}:${className}:${line}`;

            currentClass = {
              id: classId,
              name: className,
              filePath: relativePath,
              line,
              moduleNodeId,
              moduleName
            };
            classes.push(currentClass);
          }
        }

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
              moduleNodeId,
              moduleName,
              classNodeId: currentClass?.id,
              className: currentClass?.name
            });

            currentFunctionId = functionId;

            for (const parameterName of this.extractFunctionParameterNames(node, source)) {
              const parameterVar = ensureScopedVariable(parameterName, line, functionId);
              dataFlowRefs.push({
                sourceNodeId: parameterVar.id,
                targetNodeId: functionId,
                variableName: parameterName,
                reason: 'function-parameter'
              });
            }
          }
        }

        if (node.type.name === 'CallExpression' && currentFunctionId) {
          const calleePath = this.extractCalleePath(node, source);
          if (calleePath && calleePath.length > 0) {
            callRefs.push({
              sourceFunctionId: currentFunctionId,
              sourceModuleId: moduleNodeId,
              sourceModuleName: moduleName,
              calleeName: calleePath[calleePath.length - 1],
              calleePath
            });
          }
        }

        const isAssignmentNode = /Assign|Assignment/.test(node.type.name);
        if (isAssignmentNode && currentFunctionId) {
          const assignmentText = source.slice(node.from, node.to);
          const parsedAssignment = this.extractAssignmentExpression(assignmentText);

          if (parsedAssignment) {
            const line = this.positionToLine(lineMap, node.from);
            const sourceVariables = this.extractIdentifierNames(parsedAssignment.right)
              .map((name) => ensureScopedVariable(name, line, currentFunctionId));

            for (const targetName of parsedAssignment.left) {
              const targetVariable = ensureScopedVariable(targetName, line, currentFunctionId);

              if (sourceVariables.length === 0) {
                dataFlowRefs.push({
                  sourceNodeId: currentFunctionId,
                  targetNodeId: targetVariable.id,
                  variableName: targetName,
                  reason: 'literal-assignment'
                });
                continue;
              }

              for (const sourceVariable of sourceVariables) {
                dataFlowRefs.push({
                  sourceNodeId: sourceVariable.id,
                  targetNodeId: targetVariable.id,
                  variableName: targetName,
                  reason: 'assignment'
                });
              }
            }
          }
        }

        if (node.type.name === 'ReturnStatement' && currentFunctionId) {
          const returnText = source.slice(node.from, node.to).replace(/^\s*return\s+/, '');
          const line = this.positionToLine(lineMap, node.from);

          for (const identifier of this.extractIdentifierNames(returnText)) {
            const sourceVariable = ensureScopedVariable(identifier, line, currentFunctionId);
            dataFlowRefs.push({
              sourceNodeId: sourceVariable.id,
              targetNodeId: currentFunctionId,
              variableName: identifier,
              reason: 'return-flow'
            });
          }
        }

        for (let child = node.firstChild; child; child = child.nextSibling) {
          walk(child, currentFunctionId, currentClass);
        }
      };

      walk(tree.topNode);

      return { classes, functions, variables, callRefs, dataFlowRefs };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        classes,
        functions,
        variables,
        callRefs,
        dataFlowRefs,
        warning: `Parser fallback on ${relativePath}: ${errorMessage}`
      };
    }
  }

  private extractFunctionParameterNames(node: SyntaxNode, source: string): string[] {
    const paramListNode = this.findFirstChildByType(node, 'ParamList');
    if (!paramListNode) {
      return [];
    }

    const rawParamText = source.slice(paramListNode.from, paramListNode.to).trim();
    const body = rawParamText.startsWith('(') && rawParamText.endsWith(')')
      ? rawParamText.slice(1, -1)
      : rawParamText;

    return body
      .split(',')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .map((segment) => {
        const withoutDefault = segment.split('=')[0]?.trim() ?? segment;
        const withoutAnnotation = withoutDefault.split(':')[0]?.trim() ?? withoutDefault;
        return withoutAnnotation.replace(/^\*+/, '').trim();
      })
      .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      .filter((name) => !PYTHON_IDENTIFIERS_TO_SKIP.has(name.toLowerCase()));
  }

  private extractAssignmentExpression(
    statement: string
  ): { left: string[]; right: string } | undefined {
    const match = statement.match(/^\s*([A-Za-z_][A-Za-z0-9_\s,]*)\s*=\s*(.+)$/s);
    if (!match) {
      return undefined;
    }

    const left = match[1]
      .split(',')
      .map((segment) => segment.trim())
      .filter((segment) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment));

    if (left.length === 0) {
      return undefined;
    }

    return {
      left,
      right: match[2].trim()
    };
  }

  private extractIdentifierNames(expression: string): string[] {
    const matches = expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    const unique = new Set<string>();

    for (const match of matches) {
      const lowered = match.toLowerCase();
      if (PYTHON_IDENTIFIERS_TO_SKIP.has(lowered)) {
        continue;
      }

      unique.add(match);
    }

    return [...unique];
  }

  private extractImportArtifacts(
    source: string,
    moduleName: string,
    relativePath: string
  ): { dependencies: string[]; importBindings: ImportBinding[] } {
    const dependencies = new Set<string>();
    const importBindings: ImportBinding[] = [];

    for (const match of source.matchAll(/^\s*import\s+([^\n#]+)/gm)) {
      const importTargets = match[1].split(',');

      for (const target of importTargets) {
        const parsedTarget = this.parseAliasedTarget(target.trim());
        if (!parsedTarget) {
          continue;
        }

        dependencies.add(parsedTarget.name);
        importBindings.push({
          alias: parsedTarget.alias ?? parsedTarget.name.split('.')[0],
          kind: 'module',
          moduleName: parsedTarget.name
        });
      }
    }

    for (const match of source.matchAll(/^\s*from\s+([\.\w]+)\s+import\s+([^\n#]+)/gm)) {
      const importModule = this.resolveImportModule(match[1], moduleName, relativePath);
      if (!importModule) {
        continue;
      }

      dependencies.add(importModule);
      const importTargets = match[2].replace(/[()]/g, '').split(',');

      for (const target of importTargets) {
        const parsedTarget = this.parseAliasedTarget(target.trim());
        if (!parsedTarget || parsedTarget.name === '*') {
          continue;
        }

        importBindings.push({
          alias: parsedTarget.alias ?? parsedTarget.name,
          kind: 'symbol',
          moduleName: importModule,
          symbolName: parsedTarget.name
        });
      }
    }

    return {
      dependencies: [...dependencies],
      importBindings
    };
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

  private extractCalleePath(node: SyntaxNode, source: string): string[] | undefined {
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

    return parts;
  }

  private parseAliasedTarget(target: string): { name: string; alias?: string } | undefined {
    const normalizedTarget = target.trim();
    if (!normalizedTarget) {
      return undefined;
    }

    const parsed = normalizedTarget.match(/^([A-Za-z_][\w\.]*|\*)(?:\s+as\s+([A-Za-z_]\w*))?$/);
    if (!parsed) {
      return undefined;
    }

    return {
      name: parsed[1],
      alias: parsed[2]
    };
  }

  private resolveImportModule(
    rawImportModule: string,
    currentModuleName: string,
    relativePath: string
  ): string | undefined {
    if (!rawImportModule.startsWith('.')) {
      return rawImportModule;
    }

    const parsed = rawImportModule.match(/^(\.+)(.*)$/);
    if (!parsed) {
      return undefined;
    }

    const level = parsed[1].length;
    const remainder = parsed[2].trim();
    const currentPackageName = this.packageNameFromModule(currentModuleName, relativePath);
    const packageParts = currentPackageName ? currentPackageName.split('.') : [];
    const upwardLevels = level - 1;

    if (upwardLevels > packageParts.length) {
      return remainder || undefined;
    }

    const baseParts = packageParts.slice(0, packageParts.length - upwardLevels);
    const importParts = remainder ? remainder.split('.') : [];
    const resolvedParts = [...baseParts, ...importParts].filter((part) => part.length > 0);

    return resolvedParts.length > 0 ? resolvedParts.join('.') : undefined;
  }

  private packageNameFromModule(moduleName: string, relativePath: string): string {
    if (relativePath.endsWith('/__init__.py') || relativePath === '__init__.py') {
      return moduleName;
    }

    const lastDotIndex = moduleName.lastIndexOf('.');
    if (lastDotIndex < 0) {
      return '';
    }

    return moduleName.slice(0, lastDotIndex);
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
