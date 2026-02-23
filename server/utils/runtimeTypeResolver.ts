import fs from 'fs';
import path from 'path';
import { parseFileTypeContext } from '../dev/typeMap/typeContext';
import { ROOT_DIR, TSCONFIG_ALIAS_FILES } from './paths';

type ResolveResult =
  | { status: 'success'; typeText: string }
  | { status: 'error'; message: string };

interface ObjectField {
  key: string;
  optional: boolean;
  type: string;
}

interface FileContext {
  content: string;
  localTypes: Map<string, string>;
  exportedTypes: Set<string>;
  reExportedNames: Map<string, { source: string; originalName: string }>;
  exportAllSources: string[];
  defaultExportExpression: string | null;
  defaultExportName: string | null;
}

const MAX_DEPTH = 20;
const unresolvedPrefix = '__RUNTIME_UNRESOLVED__::';
const builtins = new Set([
  'string',
  'number',
  'boolean',
  'null',
  'undefined',
  'any',
  'unknown',
  'Date',
  'Promise',
  'Array',
  'Record',
  'Partial',
  'Required',
  'Pick',
  'Omit',
  'Function',
  'Map',
  'Set',
  'Buffer',
  'Uint8Array',
  'Object',
]);

const fileContextCache = new Map<string, FileContext>();
const resolvedTypeCache = new Map<string, ResolveResult>();
let tsconfigAliasEntriesCache: Array<{ key: string; target: string; baseUrl: string }> | null = null;

const toUnresolved = (message: string): string => `${unresolvedPrefix}${message}`;
export const isUnresolvedTypeMarker = (value: string): boolean => value.startsWith(unresolvedPrefix);
export const getUnresolvedTypeMessage = (value: string): string => value.slice(unresolvedPrefix.length).trim();

export const clearRuntimeTypeResolverCache = () => {
  fileContextCache.clear();
  resolvedTypeCache.clear();
  tsconfigAliasEntriesCache = null;
};

const stripJsonComments = (value: string): string => {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
};

const getTsconfigAliasEntries = (): Array<{ key: string; target: string; baseUrl: string }> => {
  if (tsconfigAliasEntriesCache) return tsconfigAliasEntriesCache;

  const entries: Array<{ key: string; target: string; baseUrl: string }> = [];

  for (const configFile of TSCONFIG_ALIAS_FILES) {
    const absolutePath = path.resolve(ROOT_DIR, configFile);
    if (!fs.existsSync(absolutePath)) continue;

    const raw = fs.readFileSync(absolutePath, 'utf-8');
    let parsed: any;
    try {
      parsed = JSON.parse(stripJsonComments(raw));
    } catch {
      continue;
    }

    const compilerOptions = parsed?.compilerOptions || {};
    const baseUrl = typeof compilerOptions.baseUrl === 'string' ? compilerOptions.baseUrl : './';
    const paths = compilerOptions.paths || {};

    for (const [key, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets)) continue;
      for (const target of targets) {
        if (typeof target !== 'string') continue;
        entries.push({ key, target, baseUrl });
      }
    }
  }

  const deduped = new Map<string, { key: string; target: string; baseUrl: string }>();
  for (const entry of entries) {
    const dedupeKey = `${entry.key}::${entry.target}::${entry.baseUrl}`;
    if (!deduped.has(dedupeKey)) deduped.set(dedupeKey, entry);
  }

  tsconfigAliasEntriesCache = Array.from(deduped.values());
  return tsconfigAliasEntriesCache;
};

const resolveAliasedBasePaths = (source: string): string[] => {
  const candidates: string[] = [];

  for (const entry of getTsconfigAliasEntries()) {
    const aliasHasStar = entry.key.includes('*');
    const targetHasStar = entry.target.includes('*');
    let captured = '';

    if (aliasHasStar) {
      const [prefix, suffix] = entry.key.split('*');
      if (!source.startsWith(prefix || '')) continue;
      if (suffix && !source.endsWith(suffix)) continue;
      const startIndex = (prefix || '').length;
      const endIndex = suffix ? source.length - suffix.length : source.length;
      captured = source.slice(startIndex, endIndex);
    } else if (entry.key !== source) {
      continue;
    }

    const targetPath = targetHasStar ? entry.target.replace('*', captured) : entry.target;
    const absolutePath = path.resolve(ROOT_DIR, entry.baseUrl, targetPath);
    candidates.push(absolutePath);
  }

  return Array.from(new Set(candidates));
};

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

const extractBalancedBraces = (content: string, startIndex: number): string | null => {
  if (content[startIndex] !== '{') return null;

  let depth = 0;
  for (let index = startIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      return content.slice(startIndex, index + 1);
    }
  }

  return null;
};

const extractBalancedUntilSemicolon = (content: string, startIndex: number): string | null => {
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let depthAngle = 0;

  for (let index = startIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === '(') depthParen += 1;
    if (char === ')') depthParen -= 1;
    if (char === '{') depthBrace += 1;
    if (char === '}') depthBrace -= 1;
    if (char === '[') depthBracket += 1;
    if (char === ']') depthBracket -= 1;
    if (char === '<') depthAngle += 1;
    if (char === '>') depthAngle -= 1;

    if (char === ';' && depthParen === 0 && depthBrace === 0 && depthBracket === 0 && depthAngle === 0) {
      return content.slice(startIndex, index).trim();
    }
  }

  return null;
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
          fields.push({ key: match[1].replace(/^['"]|['"]$/g, ''), optional: Boolean(match[2]), type: match[3].trim() });
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
      fields.push({ key: match[1].replace(/^['"]|['"]$/g, ''), optional: Boolean(match[2]), type: match[3].trim() });
    }
  }

  return fields;
};

const serializeObjectFields = (fields: ObjectField[]): string => {
  if (!fields.length) return '{ }';
  return `{ ${fields.map((field) => `${field.key}${field.optional ? '?' : ''}: ${field.type}`).join('; ')} }`;
};

const parseLiteralUnionKeys = (value: string): string[] | null => {
  const parts = splitTopLevel(value, '|');
  if (!parts.length) return null;

  const keys: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    const literalMatch = trimmed.match(/^['"](.+)['"]$/);
    if (!literalMatch) return null;
    keys.push(literalMatch[1]);
  }

  return keys;
};

const resolveImportFilePath = (source: string, currentFilePath: string): string | null => {
  const basePaths: string[] = [];

  if (source.startsWith('.')) {
    basePaths.push(path.resolve(path.dirname(currentFilePath), source));
  } else {
    basePaths.push(...resolveAliasedBasePaths(source));

    if (basePaths.length === 0) {
      if (source.startsWith('src/')) {
        basePaths.push(path.resolve(ROOT_DIR, source));
      } else if (source.startsWith('@/')) {
        basePaths.push(path.resolve(ROOT_DIR, 'src', source.slice(2)));
      } else if (source.startsWith('server/')) {
        basePaths.push(path.resolve(ROOT_DIR, source));
      } else if (source.startsWith('shared/')) {
        basePaths.push(path.resolve(ROOT_DIR, source));
      } else if (source === 'config') {
        basePaths.push(path.resolve(ROOT_DIR, 'config'));
        basePaths.push(path.resolve(ROOT_DIR, 'config.ts'));
      }
    }
  }

  if (!basePaths.length) return null;

  const candidates: string[] = [];
  for (const basePath of basePaths) {
    candidates.push(
      basePath,
      `${basePath}.ts`,
      `${basePath}.tsx`,
      path.join(basePath, 'index.ts'),
      path.join(basePath, 'index.tsx'),
    );
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
};

const extractLocalTypes = (content: string): {
  localTypes: Map<string, string>;
  exportedTypes: Set<string>;
  defaultExportExpression: string | null;
  defaultExportName: string | null;
} => {
  const localTypes = new Map<string, string>();
  const exportedTypes = new Set<string>();
  let defaultExportExpression: string | null = null;
  let defaultExportName: string | null = null;

  const interfaceRegex = /(?:export\s+)?(?:default\s+)?interface\s+(\w+)\b/g;
  let interfaceMatch: RegExpExecArray | null;
  while ((interfaceMatch = interfaceRegex.exec(content)) !== null) {
    const name = interfaceMatch[1];
    const braceStart = content.indexOf('{', interfaceMatch.index + interfaceMatch[0].length);
    if (braceStart < 0) continue;
    const body = extractBalancedBraces(content, braceStart);
    if (!body) continue;
    localTypes.set(name, body.trim());
    if (interfaceMatch[0].includes('export ')) exportedTypes.add(name);
    if (interfaceMatch[0].includes('default ')) defaultExportName = name;
  }

  const typeRegex = /(?:export\s+)?type\s+(\w+)\b[^=]*=\s*/g;
  let typeMatch: RegExpExecArray | null;
  while ((typeMatch = typeRegex.exec(content)) !== null) {
    const name = typeMatch[1];
    const valueStart = typeMatch.index + typeMatch[0].length;
    const value = extractBalancedUntilSemicolon(content, valueStart);
    if (!value) continue;
    localTypes.set(name, value.trim());
    if (typeMatch[0].includes('export ')) exportedTypes.add(name);
  }

  const defaultNamedRegex = /export\s+default\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/;
  const defaultNamedMatch = content.match(defaultNamedRegex);
  if (defaultNamedMatch) {
    defaultExportName = defaultNamedMatch[1];
  }

  const defaultTypeRegex = /export\s+default\s+type\s+[A-Za-z_][A-Za-z0-9_]*\b[^=]*=\s*/;
  const defaultTypeMatch = defaultTypeRegex.exec(content);
  if (defaultTypeMatch) {
    const valueStart = defaultTypeMatch.index + defaultTypeMatch[0].length;
    const value = extractBalancedUntilSemicolon(content, valueStart);
    if (value) defaultExportExpression = value.trim();
  }

  return { localTypes, exportedTypes, defaultExportExpression, defaultExportName };
};

const parseReExports = (content: string) => {
  const reExportedNames = new Map<string, { source: string; originalName: string }>();
  const exportAllSources: string[] = [];

  const namedReExportRegex = /export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  let namedReExportMatch: RegExpExecArray | null;
  while ((namedReExportMatch = namedReExportRegex.exec(content)) !== null) {
    const namedBlock = namedReExportMatch[1];
    const source = namedReExportMatch[2];

    namedBlock.split(',').forEach((item) => {
      const [originalName, aliasName] = item.split(/\s+as\s+/).map((value) => value.trim());
      if (!originalName) return;
      reExportedNames.set(aliasName || originalName, {
        source,
        originalName,
      });
    });
  }

  const exportAllRegex = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  let exportAllMatch: RegExpExecArray | null;
  while ((exportAllMatch = exportAllRegex.exec(content)) !== null) {
    exportAllSources.push(exportAllMatch[1]);
  }

  return { reExportedNames, exportAllSources };
};

const getFileContext = (filePath: string): FileContext | null => {
  if (!filePath || !fs.existsSync(filePath)) return null;
  if (fileContextCache.has(filePath)) return fileContextCache.get(filePath)!;

  const content = fs.readFileSync(filePath, 'utf-8');
  const { localTypes, exportedTypes, defaultExportExpression, defaultExportName } = extractLocalTypes(content);
  const { reExportedNames, exportAllSources } = parseReExports(content);

  const parsedContext = {
    content,
    localTypes,
    exportedTypes,
    reExportedNames,
    exportAllSources,
    defaultExportExpression,
    defaultExportName,
  };

  fileContextCache.set(filePath, parsedContext);
  return parsedContext;
};

interface ResolveState {
  stack: Set<string>;
}

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
    if (utilityArgs.length !== 1) {
      return toUnresolved(`unresolved utility ${utilityName}<...>`);
    }

    const target = resolveExpression(utilityArgs[0], filePath, depth + 1, state);
    if (isUnresolvedTypeMarker(target)) return target;
    const fields = parseObjectFields(target);
    if (!fields.length) {
      return toUnresolved(`unresolved utility ${utilityName}<${utilityArgs[0]}>`);
    }

    const transformed = fields.map((field) => ({
      ...field,
      optional: utilityName === 'Partial' ? true : false,
    }));
    return serializeObjectFields(transformed);
  }

  if (utilityName === 'Pick' || utilityName === 'Omit') {
    if (utilityArgs.length !== 2) {
      return toUnresolved(`unresolved utility ${utilityName}<...>`);
    }

    const target = resolveExpression(utilityArgs[0], filePath, depth + 1, state);
    if (isUnresolvedTypeMarker(target)) return target;
    const keys = parseLiteralUnionKeys(utilityArgs[1]);
    if (!keys) {
      return toUnresolved(`unresolved utility ${utilityName}<${utilityArgs.join(', ')}>`);
    }

    const fields = parseObjectFields(target);
    if (!fields.length) {
      return toUnresolved(`unresolved utility ${utilityName}<${utilityArgs[0]}, ${utilityArgs[1]}>`);
    }

    const keySet = new Set(keys);
    const transformed = fields.filter((field) => (utilityName === 'Pick' ? keySet.has(field.key) : !keySet.has(field.key)));
    return serializeObjectFields(transformed);
  }

  if (utilityName === 'Record') {
    if (utilityArgs.length !== 2) {
      return toUnresolved('unresolved utility Record<...>');
    }

    const resolvedKey = resolveExpression(utilityArgs[0], filePath, depth + 1, state);
    const resolvedValue = resolveExpression(utilityArgs[1], filePath, depth + 1, state);
    if (isUnresolvedTypeMarker(resolvedKey)) return resolvedKey;
    if (isUnresolvedTypeMarker(resolvedValue)) return resolvedValue;

    const keys = parseLiteralUnionKeys(resolvedKey);
    if (!keys) {
      return `Record<${resolvedKey}, ${resolvedValue}>`;
    }

    return serializeObjectFields(keys.map((key) => ({ key, optional: false, type: resolvedValue })));
  }

  return toUnresolved(`unresolved utility ${utilityName}<${utilityArgs.join(', ')}>`);
};

const resolveExportedSymbol = (
  filePath: string,
  symbolName: string,
  depth: number,
  state: ResolveState,
): string | null => {
  const context = getFileContext(filePath);
  if (!context) return null;

  if (symbolName === '__default__') {
    if (context.defaultExportExpression) {
      return resolveExpression(context.defaultExportExpression, filePath, depth + 1, state);
    }

    if (context.defaultExportName) {
      return resolveExpression(context.defaultExportName, filePath, depth + 1, state);
    }
  }

  if (context.localTypes.has(symbolName)) {
    return resolveExpression(context.localTypes.get(symbolName)!, filePath, depth + 1, state);
  }

  if (context.reExportedNames.has(symbolName)) {
    const target = context.reExportedNames.get(symbolName)!;
    const targetFile = resolveImportFilePath(target.source, filePath);
    if (!targetFile) {
      return toUnresolved(`unresolved type ${symbolName} imported from ${target.source}`);
    }
    return resolveExportedSymbol(targetFile, target.originalName, depth + 1, state);
  }

  for (const source of context.exportAllSources) {
    const targetFile = resolveImportFilePath(source, filePath);
    if (!targetFile) continue;

    const resolved = resolveExportedSymbol(targetFile, symbolName, depth + 1, state);
    if (resolved) return resolved;
  }

  return null;
};

const resolveIdentifier = (identifier: string, filePath: string, depth: number, state: ResolveState): string => {
  const normalizedIdentifier = identifier.trim();
  const loweredIdentifier = normalizedIdentifier.toLowerCase();

  if (['string', 'number', 'boolean', 'null', 'undefined', 'any', 'unknown'].includes(loweredIdentifier)) {
    return loweredIdentifier;
  }

  if (builtins.has(normalizedIdentifier)) return normalizedIdentifier;
  if (!filePath) return toUnresolved(`unresolved type ${identifier}`);

  const context = getFileContext(filePath);
  if (!context) return toUnresolved(`unresolved type ${identifier}`);

  if (context.localTypes.has(normalizedIdentifier)) {
    return resolveExpression(context.localTypes.get(normalizedIdentifier)!, filePath, depth + 1, state);
  }

  const { fileImports } = parseFileTypeContext(context.content);
  const importMeta = fileImports.get(normalizedIdentifier);
  if (importMeta) {
    const importedFile = resolveImportFilePath(importMeta.source, filePath);
    if (!importedFile) {
      return toUnresolved(`unresolved type ${normalizedIdentifier} imported from ${importMeta.source}`);
    }

    const importedSymbol = importMeta.isDefault ? '__default__' : importMeta.originalName || normalizedIdentifier;
    const resolvedFromImport = resolveExportedSymbol(importedFile, importedSymbol, depth + 1, state);
    if (!resolvedFromImport) {
      return toUnresolved(`unresolved type ${normalizedIdentifier} imported from ${importMeta.source}`);
    }
    return resolvedFromImport;
  }

  return toUnresolved(`unresolved type ${normalizedIdentifier}`);
};

const resolveExpression = (typeText: string, filePath: string, depth: number, state: ResolveState): string => {
  const type = typeText.trim();
  if (!type) return type;

  const visitKey = `${filePath}::${type}`;
  if (state.stack.has(visitKey)) {
    return toUnresolved(`cyclic type reference ${type}`);
  }
  if (depth > MAX_DEPTH) {
    return toUnresolved(`resolution depth exceeded for ${type}`);
  }

  state.stack.add(visitKey);

  if (isUnresolvedTypeMarker(type)) {
    state.stack.delete(visitKey);
    return type;
  }

  if (type.startsWith('(') && type.endsWith(')')) {
    const resolvedParen = resolveExpression(type.slice(1, -1), filePath, depth + 1, state);
    state.stack.delete(visitKey);
    return isUnresolvedTypeMarker(resolvedParen) ? resolvedParen : `(${resolvedParen})`;
  }

  const unionParts = splitTopLevel(type, '|');
  if (unionParts.length > 1) {
    const resolvedUnion = unionParts.map((part) => resolveExpression(part, filePath, depth + 1, state));
    const unresolved = resolvedUnion.find((part) => isUnresolvedTypeMarker(part));
    state.stack.delete(visitKey);
    if (unresolved) return unresolved;
    return resolvedUnion.join(' | ');
  }

  const intersectionParts = splitTopLevel(type, '&');
  if (intersectionParts.length > 1) {
    const resolvedIntersection = intersectionParts.map((part) => resolveExpression(part, filePath, depth + 1, state));
    const unresolved = resolvedIntersection.find((part) => isUnresolvedTypeMarker(part));
    state.stack.delete(visitKey);
    if (unresolved) return unresolved;
    return resolvedIntersection.join(' & ');
  }

  if (type.endsWith('[]')) {
    const resolvedArrayInner = resolveExpression(type.slice(0, -2), filePath, depth + 1, state);
    state.stack.delete(visitKey);
    if (isUnresolvedTypeMarker(resolvedArrayInner)) return resolvedArrayInner;
    return `${resolvedArrayInner}[]`;
  }

  if (type.startsWith('{') && type.endsWith('}')) {
    const fields = parseObjectFields(type);
    const resolvedFields: ObjectField[] = [];

    for (const field of fields) {
      const resolvedFieldType = resolveExpression(field.type, filePath, depth + 1, state);
      if (isUnresolvedTypeMarker(resolvedFieldType)) {
        state.stack.delete(visitKey);
        return resolvedFieldType;
      }
      resolvedFields.push({ ...field, type: resolvedFieldType });
    }

    state.stack.delete(visitKey);
    return serializeObjectFields(resolvedFields);
  }

  const genericMatch = type.match(/^([A-Za-z_][A-Za-z0-9_]*)<(.+)>$/);
  if (genericMatch) {
    const genericName = genericMatch[1];
    const genericArgs = splitTopLevel(genericMatch[2], ',');

    if (genericName === 'Array' && genericArgs.length === 1) {
      const resolvedArrayValue = resolveExpression(genericArgs[0], filePath, depth + 1, state);
      state.stack.delete(visitKey);
      if (isUnresolvedTypeMarker(resolvedArrayValue)) return resolvedArrayValue;
      return `${resolvedArrayValue}[]`;
    }

    if (['Partial', 'Required', 'Pick', 'Omit', 'Record'].includes(genericName)) {
      const resolvedUtility = applyUtilityType({
        utilityName: genericName,
        utilityArgs: genericArgs,
        filePath,
        depth,
        state,
      });
      state.stack.delete(visitKey);
      return resolvedUtility;
    }

    const resolvedGenericArgs = genericArgs.map((arg) => resolveExpression(arg, filePath, depth + 1, state));
    const unresolved = resolvedGenericArgs.find((arg) => isUnresolvedTypeMarker(arg));
    state.stack.delete(visitKey);
    if (unresolved) return unresolved;
    return `${genericName}<${resolvedGenericArgs.join(', ')}>`;
  }

  const identifierMatch = type.match(/^[A-Za-z_][A-Za-z0-9_]*$/);
  if (identifierMatch) {
    const resolvedIdentifier = resolveIdentifier(type, filePath, depth + 1, state);
    state.stack.delete(visitKey);
    return resolvedIdentifier;
  }

  state.stack.delete(visitKey);
  return type;
};

export const resolveRuntimeTypeText = ({
  typeText,
  filePath,
}: {
  typeText: string;
  filePath?: string;
}): ResolveResult => {
  const cleanType = typeText.trim();
  if (!cleanType) {
    return { status: 'success', typeText: cleanType };
  }

  if (!filePath) {
    return { status: 'success', typeText: cleanType };
  }

  const cacheKey = `${filePath}::${cleanType}`;
  if (resolvedTypeCache.has(cacheKey)) {
    return resolvedTypeCache.get(cacheKey)!;
  }

  const resolved = resolveExpression(cleanType, filePath, 0, { stack: new Set<string>() });
  const result: ResolveResult = isUnresolvedTypeMarker(resolved)
    ? { status: 'error', message: getUnresolvedTypeMessage(resolved) }
    : { status: 'success', typeText: resolved };

  resolvedTypeCache.set(cacheKey, result);
  return result;
};