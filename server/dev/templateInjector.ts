import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GENERATED_SOCKET_TYPES_PATH } from '../utils/paths';

/**
 * Template Injector
 * 
 * Injects default templates into new empty files in _api and _sync folders.
 * Handles sync file pairing with context-aware template selection.
 */


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const templatesDir = path.join(__dirname, 'templates');

export const isEmptyFile = (filePath: string): boolean => {
  try {
    const stats = fs.statSync(filePath);
    return stats.size === 0;
  } catch {
    return false;
  }
};

export const isInApiFolder = (filePath: string): boolean => {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.includes('/_api/') && filePath.endsWith('.ts');
};

export const isInSyncFolder = (filePath: string): boolean => {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.includes('/_sync/') && filePath.endsWith('.ts');
};

export const isSyncServerFile = (filePath: string): boolean => {
  return /_server_v\d+\.ts$/.test(filePath);
};

export const isSyncClientFile = (filePath: string): boolean => {
  return /_client_v\d+\.ts$/.test(filePath);
};

const isVersionedApiFile = (filePath: string): boolean => {
  return /_v\d+\.ts$/.test(filePath);
};

const isVersionedSyncFile = (filePath: string): boolean => {
  return /_(?:server|client)_v\d+\.ts$/.test(filePath);
};

const getInvalidVersionMessage = (filePath: string): string => {
  if (isInApiFolder(filePath)) {
    return `// Invalid API filename.\n// API files must end with _v<number>.ts\n// Example: updateUser_v1.ts\n`;
  }

  if (isInSyncFolder(filePath)) {
    return `// Invalid sync filename.\n// Sync files must end with _server_v<number>.ts or _client_v<number>.ts\n// Example: updateCounter_server_v1.ts\n`;
  }

  return `// Invalid route filename.`;
};

/**
 * Get the paired sync file path (server -> client or client -> server)
 */
export const getPairedSyncFile = (filePath: string): string | null => {
  const normalized = filePath.replace(/\\/g, '/');
  if (isSyncServerFile(normalized)) {
    return normalized.replace(/_server_v(\d+)\.ts$/, '_client_v$1.ts');
  }
  if (isSyncClientFile(normalized)) {
    return normalized.replace(/_client_v(\d+)\.ts$/, '_server_v$1.ts');
  }
  return null;
};

/**
 * Check if a paired sync file exists
 */
export const hasPairedFile = (filePath: string): boolean => {
  const pairedPath = getPairedSyncFile(filePath);
  if (!pairedPath) return false;
  return fs.existsSync(pairedPath);
};

/**
 * Extract page path from a sync file path (e.g., "examples" from "src/examples/_sync/test_server.ts")
 */
export const extractSyncPagePath = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/src\/(.+?)\/_sync\//);
  return match ? match[1] : '';
};

/**
 * Extract sync name from a sync file path (e.g., "test" from "src/examples/_sync/test_server.ts")
 */
export const extractSyncName = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/_sync\/(.+)\.ts$/);
  if (!match) {
    const basename = path.basename(filePath, '.ts');
    return basename.replace(/_server_v\d+$/, '').replace(/_client_v\d+$/, '');
  }

  return match[1].replace(/_server_v\d+$/, '').replace(/_client_v\d+$/, '');
};

/**
 * Extract clientInput type body from a sync file's SyncParams interface
 * Returns the content between the braces of clientInput: { ... }
 */
export const extractClientInputFromFile = (filePath: string): string | null => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Find interface SyncParams
    const syncParamsMatch = content.match(/interface\s+SyncParams\s*\{/);
    if (!syncParamsMatch) return null;

    // Find clientInput property
    const clientInputMatch = content.match(/clientInput\s*:\s*\{/);
    if (!clientInputMatch) return null;

    // Extract balanced braces
    const startIndex = content.indexOf('{', clientInputMatch.index!);
    let depth = 0;
    let endIndex = startIndex;

    for (let i = startIndex; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;

      if (depth === 0) {
        endIndex = i;
        break;
      }
    }

    return content.substring(startIndex, endIndex + 1);
  } catch (error) {
    console.error(`[TemplateInjector] Error extracting clientInput from ${filePath}:`, error);
    return null;
  }
};

/**
 * Extract clientInput type from the generated apiTypes.generated.ts file
 * Used when the server file is already deleted but we need to migrate types to client
 */
export const extractClientInputFromGeneratedTypes = (pagePath: string, syncName: string): string | null => {
  try {
    const generatedTypesPath = GENERATED_SOCKET_TYPES_PATH;
    const content = fs.readFileSync(generatedTypesPath, 'utf-8');

    const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedPagePath = escapeRegex(pagePath);
    const escapedSyncName = escapeRegex(syncName);

    const pageBlockRegex = new RegExp(`'${escapedPagePath}'\\s*:\\s*\\{([\\s\\S]*?)\\n\\s{2}\\};`, 'm');
    const pageBlockMatch = content.match(pageBlockRegex);
    if (!pageBlockMatch || !pageBlockMatch[1]) {
      console.log(`[TemplateInjector] Could not find page block for ${pagePath}`);
      return null;
    }

    const pageBlock = pageBlockMatch[1];

    const syncEntryPattern = new RegExp(`'${escapedSyncName}':\\s*\\{\\s*clientInput:\\s*`);
    const match = pageBlock.match(syncEntryPattern);

    if (!match || typeof match.index !== 'number') {
      console.log(`[TemplateInjector] Could not find sync entry for ${pagePath}/${syncName}`);
      return null;
    }

    const pageStart = content.indexOf(pageBlock);
    const globalMatchIndex = pageStart + match.index;

    // Find the start of clientInput value (the opening brace)
    const searchStart = globalMatchIndex + match[0].length;
    const braceStart = content.indexOf('{', searchStart - 1);

    if (braceStart === -1) return null;

    // Extract balanced braces
    let depth = 0;
    let endIndex = braceStart;

    for (let i = braceStart; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;

      if (depth === 0) {
        endIndex = i;
        break;
      }
    }

    const extracted = content.substring(braceStart, endIndex + 1);
    console.log(`[TemplateInjector] Extracted clientInput types: ${extracted}`);
    return extracted;
  } catch (error) {
    console.error(`[TemplateInjector] Error extracting clientInput from generated types:`, error);
    return null;
  }
};

/**
 * Calculate the relative path prefix (e.g., '../../../') to reach project root from a file
 * @param filePath - Absolute or relative path to the file
 * @returns The relative path prefix to reach project root
 */
export const calculateRelativePath = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');

  // Find the 'src/' part of the path
  const srcIndex = normalized.indexOf('src/');
  if (srcIndex === -1) {
    // Fallback: count from beginning if src not found
    console.warn(`[TemplateInjector] Could not find /src/ in path: ${filePath}`);
    return '../../../'; // default fallback
  }

  // Get path after 'src/' (e.g., 'examples/examples2/_api/file.ts')
  const relativePath = normalized.substring(srcIndex + 4); // +4 to skip 'src/'

  // Count segments (directories + filename)
  const segments = relativePath.split('/').filter(s => s.length > 0).length;

  // We need to go up `segments` levels to reach project root
  // e.g., 'examples/_api/file.ts' = 3 segments -> '../../../'
  return '../'.repeat(segments);
};

const getTemplate = (filePath: string): string | null => {
  let templateFile: string;
  let pagePath = '';
  let syncName = '';

  if (isInApiFolder(filePath)) {
    templateFile = path.join(templatesDir, 'api.template.ts');
  } else if (isInSyncFolder(filePath)) {
    if (isSyncServerFile(filePath)) {
      templateFile = path.join(templatesDir, 'sync_server.template.ts');
    } else if (isSyncClientFile(filePath)) {
      // Check if _server.ts exists - use paired template if so
      if (hasPairedFile(filePath)) {
        templateFile = path.join(templatesDir, 'sync_client_paired.template.ts');
        pagePath = extractSyncPagePath(filePath);
        syncName = extractSyncName(filePath);
      } else {
        templateFile = path.join(templatesDir, 'sync_client_standalone.template.ts');
      }
    } else {
      console.log(`[TemplateInjector] Unknown sync file type: ${filePath}`);
      return null;
    }
  } else {
    return null;
  }

  try {
    let content = fs.readFileSync(templateFile, 'utf-8');

    // Replace path placeholders with computed relative paths
    const relPath = calculateRelativePath(filePath);
    const pattern = /\/\/\s*@ts-expect-error.*(?:\r?\n)(.*)(?:\{\{REL_PATH\}\})/g;

    content = content.replace(pattern, (_, prefix) => {
      return `${prefix}${relPath}`;
    });

    // Replace page path and sync name placeholders for paired templates
    if (pagePath && syncName) {
      content = content.replace(/\{\{PAGE_PATH\}\}/g, pagePath);
      content = content.replace(/\{\{SYNC_NAME\}\}/g, syncName);
    }

    return content;
  } catch (error) {
    console.error(`[TemplateInjector] Could not read template: ${templateFile}`, error);
    return null;
  }
};

export const injectTemplate = async (filePath: string): Promise<boolean> => {
  if (isInApiFolder(filePath) && !isVersionedApiFile(filePath)) {
    fs.writeFileSync(filePath, getInvalidVersionMessage(filePath), 'utf-8');
    console.log(`[TemplateInjector] Invalid API filename, injected guidance: ${filePath}`);
    return true;
  }

  if (isInSyncFolder(filePath) && !isVersionedSyncFile(filePath)) {
    fs.writeFileSync(filePath, getInvalidVersionMessage(filePath), 'utf-8');
    console.log(`[TemplateInjector] Invalid sync filename, injected guidance: ${filePath}`);
    return true;
  }

  const template = getTemplate(filePath);

  if (!template) {
    return false;
  }

  try {
    fs.writeFileSync(filePath, template, 'utf-8');
    console.log(`[TemplateInjector] Injected template into: ${filePath}`);
    return true;
  } catch (error) {
    console.error(`[TemplateInjector] Failed to inject template: ${filePath}`, error);
    return false;
  }
};

export const shouldInjectTemplate = (filePath: string): boolean => {
  return (isInApiFolder(filePath) || isInSyncFolder(filePath)) && isEmptyFile(filePath);
};

/**
 * Update a client file to use the paired template (imports types from generated file)
 * Called when a _server.ts is created and _client.ts already exists
 * PRESERVES user's main function code!
 */
export const updateClientFileForPairedServer = async (clientFilePath: string): Promise<boolean> => {
  try {
    const pagePath = extractSyncPagePath(clientFilePath);
    const syncName = extractSyncName(clientFilePath);

    // Read the existing client file (preserve user's code)
    let content = fs.readFileSync(clientFilePath, 'utf-8');

    // Update imports: add SyncClientInput, SyncServerOutput if not present
    if (!content.includes('SyncClientInput')) {
      content = content.replace(
        /import \{([^}]+)\} from ['"]([^'"]*apiTypes\.generated)['"]/,
        (_match, imports, path) => {
          return `import {${imports}, SyncClientInput, SyncServerOutput } from '${path}'`;
        }
      );
    }

    // Add type aliases after imports if not present
    if (!content.includes('type PagePath')) {
      const importEndMatch = content.match(/import .+?;[\r\n]+/g);
      if (importEndMatch) {
        const lastImportEnd = content.lastIndexOf(importEndMatch[importEndMatch.length - 1]) +
          importEndMatch[importEndMatch.length - 1].length;
        const typeAliases = `\n// Types are imported from the generated file based on the _server.ts definition\ntype PagePath = '${pagePath}';\ntype SyncName = '${syncName}';\n`;
        content = content.slice(0, lastImportEnd) + typeAliases + content.slice(lastImportEnd);
      }
    }

    // Replace clientInput type with imported type (preserve indentation)
    content = content.replace(
      /^(\s*)clientInput:\s*\{[^}]*\}/m,
      '$1clientInput: SyncClientInput<PagePath, SyncName>'
    );

    // Add serverOutput if not present (after clientInput in SyncParams, with matching indentation)
    if (!content.includes('serverOutput:')) {
      content = content.replace(
        /^(\s*)(clientInput:\s*SyncClientInput<PagePath, SyncName>);?\s*$/m,
        '$1$2;\n$1serverOutput: SyncServerOutput<PagePath, SyncName>;'
      );
    }

    // Add serverOutput to main function destructuring if not present
    if (content.includes('main') && !content.match(/\{\s*[^}]*serverOutput[^}]*\}\s*:\s*SyncParams/)) {
      content = content.replace(
        /\{\s*([^}]*?clientInput)([^}]*)\}\s*:\s*SyncParams/,
        '{ $1, serverOutput$2 }: SyncParams'
      );
    }

    fs.writeFileSync(clientFilePath, content, 'utf-8');
    console.log(`[TemplateInjector] Updated client file to use paired types (preserved code): ${clientFilePath}`);
    return true;
  } catch (error) {
    console.error(`[TemplateInjector] Failed to update client file: ${clientFilePath}`, error);
    return false;
  }
};

/**
 * Update a client file when the paired server file is deleted
 * Preserves user's main function code while:
 * - Inlining clientInput types
 * - Removing serverOutput from SyncParams and main function params
 */
export const updateClientFileForDeletedServer = async (
  clientFilePath: string,
  clientInputTypes: string
): Promise<boolean> => {
  try {
    // Read the existing client file (preserve user's code)
    let content = fs.readFileSync(clientFilePath, 'utf-8');

    // STEP 1: Replace clientInput type declaration FIRST (before removing imports)
    // Pattern matches: clientInput: SyncClientInput<...> or clientInput: { ... }
    // Preserve leading indentation
    content = content.replace(
      /^(\s*)clientInput:\s*SyncClientInput<[^>]+>/m,
      `$1clientInput: ${clientInputTypes}`
    );
    content = content.replace(
      /^(\s*)clientInput:\s*\{[^}]*\}/m,
      `$1clientInput: ${clientInputTypes}`
    );

    // STEP 2: Remove serverOutput line from SyncParams interface FIRST
    // Pattern: serverOutput: SyncServerOutput<...>; or serverOutput: { ... };
    // Remove entire line including its indentation
    content = content.replace(
      /^[ \t]*serverOutput:\s*SyncServerOutput<[^>]+>;?\s*\r?\n?/m,
      ''
    );
    content = content.replace(
      /^[ \t]*serverOutput:\s*\{[^}]*\};?\s*\r?\n?/m,
      ''
    );

    // STEP 3: Remove serverOutput from main function destructuring
    content = content.replace(/,\s*serverOutput(?=\s*[,}])/g, '');
    content = content.replace(/serverOutput\s*,\s*/g, '');

    // STEP 4: NOW clean up imports (after type declarations are replaced)
    content = content.replace(/,\s*SyncClientInput(?=\s*[,}])/g, '');
    content = content.replace(/,\s*SyncServerOutput(?=\s*[,}])/g, '');

    // STEP 5: Remove type aliases if present
    content = content.replace(/\/\/\s*Types are imported.*\n?/g, '');
    content = content.replace(/type PagePath = '[^']*';\s*\n?/g, '');
    content = content.replace(/type SyncName = '[^']*';\s*\n?/g, '');

    // Clean up any double newlines
    content = content.replace(/\n{3,}/g, '\n\n');

    fs.writeFileSync(clientFilePath, content, 'utf-8');
    console.log(`[TemplateInjector] Updated client file for deleted server (preserved code): ${clientFilePath}`);
    return true;
  } catch (error) {
    console.error(`[TemplateInjector] Failed to update client file: ${clientFilePath}`, error);
    return false;
  }
};

/**
 * Inject server template with pre-filled clientInput types (from existing client file)
 */
export const injectServerTemplateWithClientInput = async (
  serverFilePath: string,
  clientInputTypes: string
): Promise<boolean> => {
  try {
    const relPath = calculateRelativePath(serverFilePath);

    const templateFile = path.join(templatesDir, 'sync_server.template.ts');
    let content = fs.readFileSync(templateFile, 'utf-8');

    // Replace placeholders
    const pattern = /\/\/\s*@ts-expect-error.*(?:\r?\n)(.*)(?:\{\{REL_PATH\}\})/g;
    content = content.replace(pattern, (_, prefix) => {
      return `${prefix}${relPath}`;
    });

    // Replace the empty clientInput with the provided types
    content = content.replace(
      /clientInput:\s*\{[^}]*\}/s,
      `clientInput: ${clientInputTypes}`
    );

    fs.writeFileSync(serverFilePath, content, 'utf-8');
    console.log(`[TemplateInjector] Injected server template with clientInput: ${serverFilePath}`);
    return true;
  } catch (error) {
    console.error(`[TemplateInjector] Failed to inject server template: ${serverFilePath}`, error);
    return false;
  }
};
