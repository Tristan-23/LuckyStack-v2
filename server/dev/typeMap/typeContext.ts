import path from 'path';
import { GENERATED_SOCKET_TYPES_PATH } from '../../utils/paths';

export interface FileImport {
  source: string;
  isDefault: boolean;
  originalName?: string;
}

export interface ImportCollectors {
  namedImports: Map<string, Set<string>>;
  defaultImports: Map<string, string>;
}

const toGeneratedImportPath = (source: string, filePath: string): string => {
  if (!source.startsWith('.')) return source;

  const outputDir = path.dirname(GENERATED_SOCKET_TYPES_PATH);
  const absoluteSource = path.resolve(path.dirname(filePath), source);
  let relPath = path.relative(outputDir, absoluteSource).replace(/\\/g, '/');
  relPath = relPath.replace(/\.tsx?$/, '');
  if (!relPath.startsWith('.')) relPath = `./${relPath}`;
  return relPath;
};

export const parseFileTypeContext = (content: string) => {
  const availableExports = new Set<string>();
  const fileImports = new Map<string, FileImport>();

  const typeExportRegex = /export\s+(?:interface|type|class|enum)\s+(\w+)/g;
  let typeExportMatch;
  while ((typeExportMatch = typeExportRegex.exec(content)) !== null) {
    availableExports.add(typeExportMatch[1]);
  }

  const importRegex = /import\s+(?:type\s+)?(?:(\w+)|(?:\*\s+as\s+(\w+))|\{([^}]+)\})\s+from\s+['"]([^'"]+)['"]/g;
  let importMatch;
  while ((importMatch = importRegex.exec(content)) !== null) {
    const source = importMatch[4];
    const defaultImport = importMatch[1];
    const namespaceImport = importMatch[2];
    const namedImportBlock = importMatch[3];

    if (defaultImport) {
      fileImports.set(defaultImport, { source, isDefault: true });
    } else if (namespaceImport) {
      fileImports.set(namespaceImport, { source, isDefault: true });
    }

    if (namedImportBlock) {
      namedImportBlock.split(',').forEach(part => {
        const [originalName, aliasName] = part.split(/\s+as\s+/).map(value => value.trim());
        if (originalName) {
          fileImports.set(aliasName || originalName, {
            source,
            isDefault: false,
            originalName,
          });
        }
      });
    }
  }

  return { availableExports, fileImports };
};

export const sanitizeTypeAndCollectImports = ({
  type,
  filePath,
  availableExports,
  fileImports,
  collectors,
  knownGenerics = new Set<string>(),
}: {
  type: string;
  filePath: string;
  availableExports: Set<string>;
  fileImports: Map<string, FileImport>;
  collectors: ImportCollectors;
  knownGenerics?: Set<string>;
}): string => {
  const { namedImports, defaultImports } = collectors;

  return type.replace(/\b([A-Z][a-zA-Z0-9_]*)(<[^>]+>)?(\[\])?\b/g, (match, typeName, _generics, isArray) => {
    const builtins = ['Promise', 'Date', 'Function', 'Array', 'Record', 'Partial', 'Pick', 'Omit', 'Error', 'Map', 'Set', 'Buffer', 'Uint8Array', 'Object'];
    const existingImports = ['PrismaClient', 'SessionLayout'];

    if (builtins.includes(typeName) || existingImports.includes(typeName) || knownGenerics.has(typeName)) {
      return match;
    }

    if (fileImports.has(typeName)) {
      const importConfig = fileImports.get(typeName)!;
      const importPath = toGeneratedImportPath(importConfig.source, filePath);

      if (importConfig.isDefault) {
        if (!defaultImports.has(importPath) || defaultImports.get(importPath) === typeName) {
          defaultImports.set(importPath, typeName);
          return match;
        }
      } else {
        if (!namedImports.has(importPath)) namedImports.set(importPath, new Set());
        namedImports.get(importPath)!.add(importConfig.originalName || typeName);
        return match;
      }
    }

    if (availableExports.has(typeName)) {
      const outputDir = path.dirname(GENERATED_SOCKET_TYPES_PATH);
      let relPath = path.relative(outputDir, filePath).replace(/\\/g, '/').replace('.ts', '');
      if (!relPath.startsWith('.')) relPath = `./${relPath}`;
      if (!namedImports.has(relPath)) namedImports.set(relPath, new Set());
      namedImports.get(relPath)!.add(typeName);
      return match;
    }

    return `any${isArray || ''}`;
  });
};
