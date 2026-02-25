import ts from 'typescript';
import fs from 'fs';
import { inferHttpMethod } from '../../utils/httpApiUtils';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

// Finds an exported const declaration by name in a source file's top-level statements.
const findExportedConst = (sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration | null => {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const hasExport = statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!hasExport) continue;

    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl;
    }
  }
  return null;
};

export const extractHttpMethod = (filePath: string, apiName: string): HttpMethod => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const decl = findExportedConst(sourceFile, 'httpMethod');

    if (decl?.initializer && ts.isStringLiteral(decl.initializer)) {
      const method = decl.initializer.text.toUpperCase() as HttpMethod;
      if (['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return method;
    }
  } catch (error) {
    console.error(`[TypeMapGenerator] Error extracting httpMethod from ${filePath}:`, error);
  }

  return inferHttpMethod(apiName);
};

export const extractRateLimit = (filePath: string): number | false | undefined => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const decl = findExportedConst(sourceFile, 'rateLimit');

    if (decl?.initializer) {
      if (decl.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
      if (ts.isNumericLiteral(decl.initializer)) return Number(decl.initializer.text);
    }
  } catch (error) {
    console.error(`[TypeMapGenerator] Error extracting rateLimit from ${filePath}:`, error);
  }

  return undefined;
};

// Reads a primitive value from an AST expression node.
const readPrimitive = (node: ts.Expression): string | number | boolean | undefined => {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
};

const parseAdditionalItem = (objectLiteral: ts.ObjectLiteralExpression): Record<string, unknown> | null => {
  const item: Record<string, unknown> = {};

  for (const prop of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    const value = readPrimitive(prop.initializer);
    if (value !== undefined) item[prop.name.text] = value;
  }

  return item.key ? item : null;
};

export const extractAuth = (filePath: string): { login: boolean; additional?: Record<string, unknown>[] } => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const decl = findExportedConst(sourceFile, 'auth');
    if (!decl?.initializer || !ts.isObjectLiteralExpression(decl.initializer)) return { login: true };

    let login = true;
    let additional: Record<string, unknown>[] | undefined;

    for (const prop of decl.initializer.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;

      if (prop.name.text === 'login') {
        login = prop.initializer.kind === ts.SyntaxKind.TrueKeyword;
      }

      if (prop.name.text === 'additional' && ts.isArrayLiteralExpression(prop.initializer)) {
        additional = [];
        for (const element of prop.initializer.elements) {
          if (!ts.isObjectLiteralExpression(element)) continue;
          const item = parseAdditionalItem(element);
          if (item) additional.push(item);
        }
      }
    }

    return additional && additional.length > 0 ? { login, additional } : { login };
  } catch {
    // fall through
  }

  return { login: true };
};
