import ts from 'typescript';
import fs from 'fs';
import path from 'path';
import { FileImport, ImportCollectors, parseFileTypeContext, sanitizeTypeAndCollectImports } from './typeContext';
import { SERVER_FUNCTIONS_DIR } from '../../utils/paths';

// Strips default parameter values from argument lists so the generated interface
// is a clean type signature without runtime values.
const stripDefaultValues = (params: string): string => {
  // Replace default values (= expr) while preserving arrow functions (=>)
  return params.replace(/\s*=(?!>)[^,)]+/g, '');
};

// Extracts a function signature string from an AST function-like node.
const extractSignatureFromNode = (
  node: ts.FunctionLikeDeclaration,
  rawContent: string,
  filePath: string,
  availableExports: Set<string>,
  fileImports: Map<string, FileImport>,
  collectors: ImportCollectors,
): string => {
  // Collect generic type parameter names to avoid replacing them with 'any'
  const knownGenerics = new Set<string>();
  if (node.typeParameters) {
    for (const typeParam of node.typeParameters) {
      knownGenerics.add(typeParam.name.text);
    }
  }

  const isAsync = node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;

  // Generic clause text (<T, U extends string>)
  const genericsClause = node.typeParameters
    ? `<${rawContent.slice(node.typeParameters.pos, node.typeParameters.end).trim()}>`
    : '';

  // Parameter list text with default values removed
  const rawParams = node.parameters
    .map(p => rawContent.slice(p.pos, p.end).trim())
    .join(', ');
  const cleanParams = stripDefaultValues(`(${rawParams})`);
  const sanitizedParams = sanitizeTypeAndCollectImports({
    type: cleanParams,
    filePath,
    availableExports,
    fileImports,
    knownGenerics,
    collectors,
  });

  // Return type annotation
  let returnTypeStr = isAsync ? 'Promise<any>' : 'any';
  if (node.type) {
    const rawReturnType = rawContent.slice(node.type.pos, node.type.end).trim();
    returnTypeStr = sanitizeTypeAndCollectImports({
      type: rawReturnType,
      filePath,
      availableExports,
      fileImports,
      knownGenerics,
      collectors,
    });
    if (isAsync && !returnTypeStr.startsWith('Promise')) {
      returnTypeStr = `Promise<${returnTypeStr}>`;
    }
  }

  return `${genericsClause}${sanitizedParams} => ${returnTypeStr}`;
};

// Finds and returns the signature for a named export within a parsed source file.
const findSignatureForExport = (
  name: string,
  sourceFile: ts.SourceFile,
  rawContent: string,
  filePath: string,
  availableExports: Set<string>,
  fileImports: Map<string, FileImport>,
  collectors: ImportCollectors,
): string => {
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== name || !decl.initializer) continue;
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          return extractSignatureFromNode(decl.initializer, rawContent, filePath, availableExports, fileImports, collectors);
        }
      }
    }

    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return extractSignatureFromNode(statement, rawContent, filePath, availableExports, fileImports, collectors);
    }
  }

  return 'any';
};

const generateFunctionsForDir = (dir: string, collectors: ImportCollectors, indent = '\t'): string => {
  if (!fs.existsSync(dir)) return '';
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let output = '';

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const subOutput = generateFunctionsForDir(fullPath, collectors, `${indent}  `);
      if (subOutput.trim()) {
        output += `${indent}${entry.name}: {\n${subOutput}${indent}};\n`;
      }
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;

    const fileName = entry.name.replace('.ts', '');
    let fileOutput = '';

    try {
      const rawContent = fs.readFileSync(fullPath, 'utf-8');
      const sourceFile = ts.createSourceFile(fullPath, rawContent, ts.ScriptTarget.Latest, true);
      const { availableExports, fileImports } = parseFileTypeContext(rawContent);
      const exports = new Map<string, string>();
      let defaultExportName: string | null = null;

      for (const statement of sourceFile.statements) {
        const hasExport = (statement as ts.HasModifiers).modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);

        if (ts.isVariableStatement(statement) && hasExport) {
          for (const decl of statement.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              exports.set(decl.name.text, findSignatureForExport(decl.name.text, sourceFile, rawContent, fullPath, availableExports, fileImports, collectors));
            }
          }
        }

        if (ts.isFunctionDeclaration(statement) && hasExport && statement.name) {
          exports.set(statement.name.text, findSignatureForExport(statement.name.text, sourceFile, rawContent, fullPath, availableExports, fileImports, collectors));
        }

        // export default someIdentifier
        if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
          defaultExportName = statement.expression.text;
        }
      }

      const defaultSig = defaultExportName ? exports.get(defaultExportName) : undefined;
      if (defaultSig) exports.delete(defaultExportName!);

      for (const [exportName, sig] of exports) {
        fileOutput += `${indent}  ${exportName}: ${sig};\n`;
      }

      if (defaultSig && !fileOutput.trim()) {
        fileOutput += `${indent}  ${fileName}: ${defaultSig};\n`;
      }

      if (fileOutput) {
        output += `${indent}${fileName}: {\n${fileOutput}${indent}};\n`;
      }
    } catch (err) {
      console.error(`[TypeMapGenerator] Error parsing functions file ${fullPath}:`, err);
    }
  }

  return output;
};

export const generateServerFunctions = (collectors: ImportCollectors): string => {
  return generateFunctionsForDir(SERVER_FUNCTIONS_DIR, collectors, '\t');
};
