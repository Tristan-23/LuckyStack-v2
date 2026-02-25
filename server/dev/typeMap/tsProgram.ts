import ts from 'typescript';
import path from 'path';
import { ROOT_DIR } from '../../utils/paths';

let cachedProgram: ts.Program | null = null;

export const getServerProgram = (): ts.Program => {
  if (cachedProgram) return cachedProgram;

  const tsconfigPath = ts.findConfigFile(ROOT_DIR, ts.sys.fileExists, 'tsconfig.server.json');
  if (!tsconfigPath) throw new Error('[TypeProgram] tsconfig.server.json not found');

  const { config } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const { options, fileNames } = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    path.dirname(tsconfigPath),
  );

  cachedProgram = ts.createProgram(fileNames, options);
  return cachedProgram;
};

export const invalidateProgramCache = (): void => {
  cachedProgram = null;
};

const DEPTH_LIMIT = 12;

// Generic containers we never recursively expand (their internal shape is irrelevant to API types)
const SKIP_EXPANSION = new Set([
  'Promise', 'Map', 'WeakMap', 'Set', 'WeakSet',
  'Error', 'Date', 'RegExp', 'Buffer', 'ArrayBuffer', 'ReadonlyArray',
]);

// Recursively expand a TypeScript type to an inline type string with no named references.
// The result is self-contained and requires no imports.
export const expandType = (type: ts.Type, checker: ts.TypeChecker, depth = 0): string => {
  if (depth > DEPTH_LIMIT) return checker.typeToString(type);

  // String literals ('hello') — use single quotes for consistency with the codebase
  if (type.isStringLiteral()) return `'${type.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

  // Number literals (42, 3.14)
  if (type.isNumberLiteral()) return String(type.value);

  // Primitives and special types (string, number, boolean, true, false, null, undefined, any, unknown, never, void)
  if (
    type.flags
    & (
      ts.TypeFlags.String
      | ts.TypeFlags.Number
      | ts.TypeFlags.Boolean
      | ts.TypeFlags.BooleanLiteral
      | ts.TypeFlags.Undefined
      | ts.TypeFlags.Null
      | ts.TypeFlags.Any
      | ts.TypeFlags.Unknown
      | ts.TypeFlags.Never
      | ts.TypeFlags.Void
    )
  ) {
    return checker.typeToString(type);
  }

  // Union types (A | B | C)
  if (type.isUnion()) {
    return type.types.map(t => expandType(t, checker, depth + 1)).join(' | ');
  }

  // Intersection types (A & B)
  if (type.isIntersection()) {
    return type.types.map(t => expandType(t, checker, depth + 1)).join(' & ');
  }

  // Object types (interfaces, type literals, generic instances)
  if (type.flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;

    // Tuple types [A, B, C]
    if (objectType.objectFlags & ts.ObjectFlags.Tuple) {
      const typeArgs = checker.getTypeArguments(objectType as ts.TypeReference);
      return `[${typeArgs.map(t => expandType(t, checker, depth + 1)).join(', ')}]`;
    }

    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      const refType = objectType as ts.TypeReference;
      const targetName = refType.target?.symbol?.name ?? '';

      // Array<T> / ReadonlyArray<T> → T[]
      if (targetName === 'Array' || targetName === 'ReadonlyArray') {
        const typeArgs = checker.getTypeArguments(refType);
        if (typeArgs.length > 0) {
          return `${expandType(typeArgs[0], checker, depth + 1)}[]`;
        }
      }

      // Known opaque containers — return as-is without expanding internals
      if (SKIP_EXPANSION.has(targetName)) {
        return checker.typeToString(type);
      }
    }

    const props = checker.getPropertiesOfType(type);
    const indexInfos = checker.getIndexInfosOfType(type);

    if (props.length > 0 || indexInfos.length > 0) {
      const fields: string[] = [];

      for (const prop of props) {
        const propType = checker.getTypeOfSymbol(prop);
        const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
        fields.push(`${prop.name}${isOptional ? '?' : ''}: ${expandType(propType, checker, depth + 1)}`);
      }

      for (const indexInfo of indexInfos) {
        const keyType = expandType(indexInfo.keyType, checker, depth + 1);
        const valueType = expandType(indexInfo.type, checker, depth + 1);
        fields.push(`[key: ${keyType}]: ${valueType}`);
      }

      return `{ ${fields.join('; ')} }`;
    }

    return '{ }';
  }

  return checker.typeToString(type);
};
