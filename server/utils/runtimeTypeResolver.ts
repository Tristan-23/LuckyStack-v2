import ts from 'typescript';
import { getServerProgram, expandType } from '../dev/typeMap/tsProgram';

type ResolveResult =
  | { status: 'success'; typeText: string }
  | { status: 'error'; message: string };

interface ObjectField {
  key: string;
  optional: boolean;
  type: string;
}

interface ResolveState {
  stack: Set<string>;
}

const MAX_DEPTH = 20;
const unresolvedPrefix = '__RUNTIME_UNRESOLVED__::';

const PRIMITIVE_TYPES = new Set([
  'string', 'number', 'boolean', 'null', 'undefined', 'any', 'unknown', 'void', 'never',
]);

// These types are structurally opaque — return them as-is without expansion.
const SKIP_EXPANSION = new Set([
  'Date', 'Promise', 'Array', 'Record', 'Partial', 'Required', 'Pick', 'Omit',
  'Function', 'Map', 'Set', 'Buffer', 'Uint8Array', 'Object', 'WeakMap', 'WeakSet',
]);

const toUnresolved = (message: string): string => `${unresolvedPrefix}${message}`;
export const isUnresolvedTypeMarker = (value: string): boolean => value.startsWith(unresolvedPrefix);
export const getUnresolvedTypeMessage = (value: string): string => value.slice(unresolvedPrefix.length).trim();

const resolvedTypeCache = new Map<string, ResolveResult>();

export const clearRuntimeTypeResolverCache = () => {
  resolvedTypeCache.clear();
};

// ─── string helpers ───────────────────────────────────────────────────────────

const splitTopLevel = (value: string, splitter: '|' | '&' | ','): string[] => {
  const items: string[] = [];
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let depthAngle = 0;
  let token = '';

  for (const char of value) {
    if (char === '(') depthParen += 1;
    if (char === ')') depthParen -= 1;
    if (char === '{') depthBrace += 1;
    if (char === '}') depthBrace -= 1;
    if (char === '[') depthBracket += 1;
    if (char === ']') depthBracket -= 1;
    if (char === '<') depthAngle += 1;
    if (char === '>') depthAngle -= 1;

    if (
      char === splitter
      && depthParen === 0
      && depthBrace === 0
      && depthBracket === 0
      && depthAngle === 0
    ) {
      if (token.trim()) items.push(token.trim());
      token = '';
      continue;
    }

    token += char;
  }

  if (token.trim()) items.push(token.trim());
  return items;
};

const parseObjectFields = (typeText: string): ObjectField[] => {
  const clean = typeText.trim();
  if (!clean.startsWith('{') || !clean.endsWith('}')) return [];

  const inner = clean.slice(1, -1);
  const fields: ObjectField[] = [];
  let part = '';
  let depth = 0;

  for (const char of inner) {
    if (char === '{' || char === '[' || char === '(' || char === '<') depth += 1;
    if (char === '}' || char === ']' || char === ')' || char === '>') depth -= 1;

    if (char === ';' && depth === 0) {
      const trimmed = part.trim();
      if (trimmed) {
        const match = trimmed.match(/^(["']?[A-Za-z_][A-Za-z0-9_]*["']?)(\?)?\s*:\s*(.+)$/);
        if (match) {
          fields.push({
            key: match[1].replace(/^['"]|['"]$/g, ''),
            optional: Boolean(match[2]),
            type: match[3].trim(),
          });
        }
      }
      part = '';
      continue;
    }

    part += char;
  }

  const final = part.trim();
  if (final) {
    const match = final.match(/^(["']?[A-Za-z_][A-Za-z0-9_]*["']?)(\?)?\s*:\s*(.+)$/);
    if (match) {
      fields.push({
        key: match[1].replace(/^['"]|['"]$/g, ''),
        optional: Boolean(match[2]),
        type: match[3].trim(),
      });
    }
  }

  return fields;
};

const serializeObjectFields = (fields: ObjectField[]): string => {
  if (!fields.length) return '{ }';
  return `{ ${fields.map((f) => `${f.key}${f.optional ? '?' : ''}: ${f.type}`).join('; ')} }`;
};

const parseLiteralUnionKeys = (value: string): string[] | null => {
  const parts = splitTopLevel(value, '|');
  if (!parts.length) return null;

  const keys: string[] = [];
  for (const part of parts) {
    const literalMatch = part.trim().match(/^['"](.+)['"]$/);
    if (!literalMatch) return null;
    keys.push(literalMatch[1]);
  }

  return keys;
};

// ─── TypeChecker-based identifier resolution ──────────────────────────────────

// Resolves a named type identifier to its expanded inline type string using
// the TypeScript compiler API, following imports across files automatically.
const resolveIdentifier = (identifier: string, filePath: string): string => {
  if (PRIMITIVE_TYPES.has(identifier.toLowerCase())) return identifier.toLowerCase();
  if (SKIP_EXPANSION.has(identifier)) return identifier;

  try {
    const program = getServerProgram();
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) return toUnresolved(`unresolved type ${identifier}`);

    const checker = program.getTypeChecker();

    for (const stmt of sourceFile.statements) {
      // Local interface / type alias / enum
      if (
        (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt))
        && stmt.name.text === identifier
      ) {
        const symbol = checker.getSymbolAtLocation(stmt.name);
        if (symbol) {
          return expandType(checker.getDeclaredTypeOfSymbol(symbol), checker);
        }
      }

      // Import declarations — follow the alias to the original symbol
      if (ts.isImportDeclaration(stmt) && stmt.importClause) {
        const { namedBindings, name: defaultName } = stmt.importClause;

        if (namedBindings && ts.isNamedImports(namedBindings)) {
          for (const specifier of namedBindings.elements) {
            if (specifier.name.text === identifier) {
              const symbol = checker.getSymbolAtLocation(specifier.name);
              if (symbol) {
                const target = symbol.flags & ts.SymbolFlags.Alias
                  ? checker.getAliasedSymbol(symbol)
                  : symbol;
                return expandType(checker.getDeclaredTypeOfSymbol(target), checker);
              }
            }
          }
        }

        if (defaultName?.text === identifier) {
          const symbol = checker.getSymbolAtLocation(defaultName);
          if (symbol) {
            const target = symbol.flags & ts.SymbolFlags.Alias
              ? checker.getAliasedSymbol(symbol)
              : symbol;
            return expandType(checker.getDeclaredTypeOfSymbol(target), checker);
          }
        }
      }
    }

    return toUnresolved(`unresolved type ${identifier}`);
  } catch {
    return toUnresolved(`unresolved type ${identifier}`);
  }
};

// ─── utility type application ─────────────────────────────────────────────────

const applyUtilityType = ({
  utilityName,
  utilityArgs,
  filePath,
  depth,
  state,
}: {
  utilityName: string;
  utilityArgs: string[];
  filePath: string;
  depth: number;
  state: ResolveState;
}): string => {
  if (utilityName === 'Partial' || utilityName === 'Required') {
    if (utilityArgs.length !== 1) return toUnresolved(`unresolved utility ${utilityName}<...>`);
    const target = resolveExpression(utilityArgs[0], filePath, depth + 1, state);
    if (isUnresolvedTypeMarker(target)) return target;
    const fields = parseObjectFields(target);
    if (!fields.length) return toUnresolved(`unresolved utility ${utilityName}<${utilityArgs[0]}>`);
    return serializeObjectFields(fields.map((f) => ({ ...f, optional: utilityName === 'Partial' })));
  }

  if (utilityName === 'Pick' || utilityName === 'Omit') {
    if (utilityArgs.length !== 2) return toUnresolved(`unresolved utility ${utilityName}<...>`);
    const target = resolveExpression(utilityArgs[0], filePath, depth + 1, state);
    if (isUnresolvedTypeMarker(target)) return target;
    const keys = parseLiteralUnionKeys(utilityArgs[1]);
    if (!keys) return toUnresolved(`unresolved utility ${utilityName}<${utilityArgs.join(', ')}>`);
    const fields = parseObjectFields(target);
    if (!fields.length) return toUnresolved(`unresolved utility ${utilityName}<${utilityArgs.join(', ')}>`);
    const keySet = new Set(keys);
    const filtered = fields.filter((f) => (utilityName === 'Pick' ? keySet.has(f.key) : !keySet.has(f.key)));
    return serializeObjectFields(filtered);
  }

  if (utilityName === 'Record') {
    if (utilityArgs.length !== 2) return toUnresolved('unresolved utility Record<...>');
    const resolvedKey = resolveExpression(utilityArgs[0], filePath, depth + 1, state);
    const resolvedValue = resolveExpression(utilityArgs[1], filePath, depth + 1, state);
    if (isUnresolvedTypeMarker(resolvedKey)) return resolvedKey;
    if (isUnresolvedTypeMarker(resolvedValue)) return resolvedValue;
    const keys = parseLiteralUnionKeys(resolvedKey);
    if (!keys) return `Record<${resolvedKey}, ${resolvedValue}>`;
    return serializeObjectFields(keys.map((key) => ({ key, optional: false, type: resolvedValue })));
  }

  return toUnresolved(`unresolved utility ${utilityName}<${utilityArgs.join(', ')}>`);
};

// ─── expression resolver ──────────────────────────────────────────────────────

const resolveExpression = (typeText: string, filePath: string, depth: number, state: ResolveState): string => {
  const type = typeText.trim();
  if (!type) return type;

  const visitKey = `${filePath}::${type}`;
  if (state.stack.has(visitKey)) return toUnresolved(`cyclic type reference ${type}`);
  if (depth > MAX_DEPTH) return toUnresolved(`resolution depth exceeded for ${type}`);

  state.stack.add(visitKey);

  let result: string;

  if (isUnresolvedTypeMarker(type)) {
    result = type;
  } else if (type.startsWith('(') && type.endsWith(')')) {
    const inner = resolveExpression(type.slice(1, -1), filePath, depth + 1, state);
    result = isUnresolvedTypeMarker(inner) ? inner : `(${inner})`;
  } else {
    const unionParts = splitTopLevel(type, '|');
    if (unionParts.length > 1) {
      const resolved = unionParts.map((p) => resolveExpression(p, filePath, depth + 1, state));
      const unresolved = resolved.find(isUnresolvedTypeMarker);
      result = unresolved ?? resolved.join(' | ');
    } else {
      const intersectionParts = splitTopLevel(type, '&');
      if (intersectionParts.length > 1) {
        const resolved = intersectionParts.map((p) => resolveExpression(p, filePath, depth + 1, state));
        const unresolved = resolved.find(isUnresolvedTypeMarker);
        result = unresolved ?? resolved.join(' & ');
      } else if (type.endsWith('[]')) {
        const inner = resolveExpression(type.slice(0, -2), filePath, depth + 1, state);
        result = isUnresolvedTypeMarker(inner) ? inner : `${inner}[]`;
      } else if (type.startsWith('{') && type.endsWith('}')) {
        const fields = parseObjectFields(type);
        const resolvedFields: ObjectField[] = [];
        let hadError: string | undefined;

        for (const field of fields) {
          const resolvedType = resolveExpression(field.type, filePath, depth + 1, state);
          if (isUnresolvedTypeMarker(resolvedType)) { hadError = resolvedType; break; }
          resolvedFields.push({ ...field, type: resolvedType });
        }

        result = hadError ?? serializeObjectFields(resolvedFields);
      } else {
        const genericMatch = type.match(/^([A-Za-z_][A-Za-z0-9_]*)<(.+)>$/);
        if (genericMatch) {
          const [, genericName, argsStr] = genericMatch;
          const args = splitTopLevel(argsStr, ',');

          if (genericName === 'Array' && args.length === 1) {
            const inner = resolveExpression(args[0], filePath, depth + 1, state);
            result = isUnresolvedTypeMarker(inner) ? inner : `${inner}[]`;
          } else if (['Partial', 'Required', 'Pick', 'Omit', 'Record'].includes(genericName)) {
            result = applyUtilityType({ utilityName: genericName, utilityArgs: args, filePath, depth, state });
          } else {
            const resolvedArgs = args.map((a) => resolveExpression(a, filePath, depth + 1, state));
            const unresolved = resolvedArgs.find(isUnresolvedTypeMarker);
            result = unresolved ?? `${genericName}<${resolvedArgs.join(', ')}>`;
          }
        } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(type)) {
          result = resolveIdentifier(type, filePath);
        } else {
          result = type;
        }
      }
    }
  }

  state.stack.delete(visitKey);
  return result;
};

// ─── public API ───────────────────────────────────────────────────────────────

export const resolveRuntimeTypeText = ({
  typeText,
  filePath,
}: {
  typeText: string;
  filePath?: string;
}): ResolveResult => {
  const cleanType = typeText.trim();
  if (!cleanType || !filePath) {
    return { status: 'success', typeText: cleanType };
  }

  const cacheKey = `${filePath}::${cleanType}`;
  if (resolvedTypeCache.has(cacheKey)) return resolvedTypeCache.get(cacheKey)!;

  const resolved = resolveExpression(cleanType, filePath, 0, { stack: new Set() });
  const result: ResolveResult = isUnresolvedTypeMarker(resolved)
    ? { status: 'error', message: getUnresolvedTypeMessage(resolved) }
    : { status: 'success', typeText: resolved };

  resolvedTypeCache.set(cacheKey, result);
  return result;
};
