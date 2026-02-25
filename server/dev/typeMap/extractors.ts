import ts from 'typescript';
import { getServerProgram, expandType } from './tsProgram';

// Kept for backwards compatibility — callers outside this module may still import it.
export const stripComments = (str: string): string => {
  return str.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
};

// ─── shared helpers ──────────────────────────────────────────────────────────

// Finds a top-level interface declaration by name in a source file's statements.
const findInterface = (sourceFile: ts.SourceFile, name: string): ts.InterfaceDeclaration | null => {
  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) return stmt;
  }
  return null;
};

// Reads the type of a named property inside an interface declaration.
const getInterfacePropertyType = (
  iface: ts.InterfaceDeclaration,
  propertyName: string,
  checker: ts.TypeChecker,
): ts.Type | null => {
  for (const member of iface.members) {
    if (
      ts.isPropertySignature(member)
      && member.name
      && ts.isIdentifier(member.name)
      && member.name.text === propertyName
      && member.type
    ) {
      return checker.getTypeFromTypeNode(member.type);
    }
  }
  return null;
};

// Finds the function-like initializer of `const main = ...` in a source file.
const findMainFunction = (sourceFile: ts.SourceFile): ts.FunctionLikeDeclaration | null => {
  for (const stmt of sourceFile.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name)
          && decl.name.text === 'main'
          && decl.initializer
          && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          return decl.initializer;
        }
      }
    }

    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === 'main') {
      return stmt;
    }
  }
  return null;
};

// Collects the expanded type strings of all object-literal return statements
// in a function body, without descending into nested function definitions.
const collectReturnObjectTypes = (
  funcNode: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): string[] => {
  const types: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      const type = checker.getTypeAtLocation(node.expression);
      types.push(expandType(type, checker));
    }

    // Recurse into control flow but not into nested function bodies
    if (
      !ts.isArrowFunction(node)
      && !ts.isFunctionExpression(node)
      && !ts.isFunctionDeclaration(node)
    ) {
      ts.forEachChild(node, visit);
    }
  };

  ts.forEachChild(funcNode, visit);
  return types;
};

// Returns the deduplicated union of an array of type strings.
const unionTypes = (types: string[]): string => {
  const unique = [...new Set(types)];
  return unique.length > 0 ? unique.join(' | ') : '';
};

// ─── public API ──────────────────────────────────────────────────────────────

export const getInputTypeFromFile = (filePath: string): string => {
  const DEFAULT = '{ }';

  try {
    const program = getServerProgram();
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) return DEFAULT;

    const checker = program.getTypeChecker();
    const iface = findInterface(sourceFile, 'ApiParams');
    if (!iface) return DEFAULT;

    const dataType = getInterfacePropertyType(iface, 'data', checker);
    if (!dataType) return DEFAULT;

    return expandType(dataType, checker) || DEFAULT;
  } catch (error) {
    console.error(`[TypeMapGenerator] Error extracting input type from ${filePath}:`, error);
    return DEFAULT;
  }
};

export const getOutputTypeFromFile = (filePath: string): string => {
  const DEFAULT = '{ status: string }';

  try {
    const program = getServerProgram();
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) return DEFAULT;

    const checker = program.getTypeChecker();
    const mainFn = findMainFunction(sourceFile);
    if (!mainFn) return DEFAULT;

    const types = collectReturnObjectTypes(mainFn, checker);
    return unionTypes(types) || DEFAULT;
  } catch (error) {
    console.error(`[TypeMapGenerator] Error extracting output type from ${filePath}:`, error);
    return DEFAULT;
  }
};

export const getSyncClientDataType = (filePath: string): string => {
  const DEFAULT = '{ }';

  try {
    const program = getServerProgram();
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) return DEFAULT;

    const checker = program.getTypeChecker();
    const iface = findInterface(sourceFile, 'SyncParams');
    if (!iface) return DEFAULT;

    // Try clientInput first, then clientData (legacy name)
    const dataType =
      getInterfacePropertyType(iface, 'clientInput', checker)
      ?? getInterfacePropertyType(iface, 'clientData', checker);
    if (!dataType) return DEFAULT;

    return expandType(dataType, checker) || DEFAULT;
  } catch (error) {
    console.error(`[TypeMapGenerator] Error extracting sync clientData type from ${filePath}:`, error);
    return DEFAULT;
  }
};

export const getSyncServerOutputType = (filePath: string): string => {
  const DEFAULT = '{ status: string }';

  try {
    const program = getServerProgram();
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) return DEFAULT;

    const checker = program.getTypeChecker();
    const mainFn = findMainFunction(sourceFile);
    if (!mainFn) return DEFAULT;

    const types = collectReturnObjectTypes(mainFn, checker);
    return unionTypes(types) || DEFAULT;
  } catch (error) {
    console.error(`[TypeMapGenerator] Error extracting sync serverOutput type from ${filePath}:`, error);
    return DEFAULT;
  }
};

export const getSyncClientOutputType = (filePath: string): string => {
  const DEFAULT = '{ }';

  try {
    const program = getServerProgram();
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) return DEFAULT;

    const checker = program.getTypeChecker();
    const mainFn = findMainFunction(sourceFile);
    if (!mainFn) return DEFAULT;

    const types = collectReturnObjectTypes(mainFn, checker);
    return unionTypes(types) || DEFAULT;
  } catch (error) {
    console.error(`[TypeMapGenerator] Error extracting sync clientOutput type from ${filePath}:`, error);
    return DEFAULT;
  }
};
