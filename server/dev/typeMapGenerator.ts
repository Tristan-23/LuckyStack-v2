import { findAllApiFiles, findAllSyncClientFiles, findAllSyncServerFiles } from './typeMap/discovery';
import { extractApiName, extractApiVersion, extractPagePath, extractSyncName, extractSyncPagePath, extractSyncVersion } from './typeMap/routeMeta';
import { extractAuth, extractHttpMethod, extractRateLimit, HttpMethod } from './typeMap/apiMeta';
import { buildTypeMapArtifacts, writeTypeMapArtifacts } from './typeMap/emitterArtifacts';
import { getInputTypeFromFile, getOutputTypeFromFile, getSyncClientDataType, getSyncClientOutputType, getSyncServerOutputType } from './typeMap/extractors';
import { generateServerFunctions } from './typeMap/functionsMeta';
import { invalidateProgramCache } from './typeMap/tsProgram';
import { SRC_DIR } from '../utils/paths';

// Collect required imports for the Functions interface only.
// API/Sync types are now fully expanded by the TypeChecker and need no imports.
const namedImports = new Map<string, Set<string>>();
const defaultImports = new Map<string, string>();

export const generateTypeMapFile = (): void => {
  // Rebuild the TypeScript Program on each generation to pick up file changes.
  invalidateProgramCache();
  namedImports.clear();
  defaultImports.clear();

  // ═══════════════════════════════════════════════════════════════════════════
  // Collect API Types
  // ═══════════════════════════════════════════════════════════════════════════
  const apiFiles = findAllApiFiles(SRC_DIR);
  const typesByPage = new Map<string, Map<string, { input: string; output: string; method: HttpMethod; rateLimit: number | false | undefined; auth: any; version: string; description?: string }>>();

  console.log(`[TypeMapGenerator] Found ${apiFiles.length} API files`);

  for (const filePath of apiFiles) {
    const pagePath = extractPagePath(filePath);
    const apiName = extractApiName(filePath);
    const apiVersion = extractApiVersion(filePath);

    if (!pagePath || !apiName) continue;

    // TypeChecker-based extractors return fully-expanded inline types.
    // No import collection or sanitization is needed for API types.
    const inputType = getInputTypeFromFile(filePath);
    const outputType = getOutputTypeFromFile(filePath);
    const httpMethod = extractHttpMethod(filePath, apiName);
    const rateLimit = extractRateLimit(filePath);
    const auth = extractAuth(filePath);

    console.log(`[TypeMapGenerator] API: ${pagePath}/${apiName}/${apiVersion} (${httpMethod}${rateLimit !== undefined ? `, rateLimit: ${rateLimit}` : ''})`);

    if (!typesByPage.has(pagePath)) {
      typesByPage.set(pagePath, new Map());
    }
    typesByPage.get(pagePath)!.set(`${apiName}@${apiVersion}`, { input: inputType, output: outputType, method: httpMethod, rateLimit, auth, version: apiVersion });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Collect Sync Types
  // ═══════════════════════════════════════════════════════════════════════════
  const syncServerFiles = findAllSyncServerFiles(SRC_DIR);
  const syncClientFiles = findAllSyncClientFiles(SRC_DIR);
  const syncTypesByPage = new Map<string, Map<string, { clientInput: string; serverOutput: string; clientOutput: string; version: string }>>();

  console.log(`[TypeMapGenerator] Found ${syncServerFiles.length} Sync server files, ${syncClientFiles.length} Sync client files`);

  const allSyncs = new Map<string, {
    pagePath: string;
    syncName: string;
    serverFile?: string;
    clientFile?: string;
  }>();

  for (const serverFile of syncServerFiles) {
    const pagePath = extractSyncPagePath(serverFile);
    const syncName = extractSyncName(serverFile);
    const syncVersion = extractSyncVersion(serverFile);
    if (!pagePath || !syncName) continue;

    const key = `${pagePath}/${syncName}/${syncVersion}`;
    const existing = allSyncs.get(key) || { pagePath, syncName };
    existing.serverFile = serverFile;
    allSyncs.set(key, existing);
  }

  for (const clientFile of syncClientFiles) {
    const pagePath = extractSyncPagePath(clientFile);
    const syncName = extractSyncName(clientFile);
    const syncVersion = extractSyncVersion(clientFile);
    if (!pagePath || !syncName) continue;

    const key = `${pagePath}/${syncName}/${syncVersion}`;
    const existing = allSyncs.get(key) || { pagePath, syncName };
    existing.clientFile = clientFile;
    allSyncs.set(key, existing);
  }

  for (const [, { pagePath, syncName, serverFile, clientFile }] of allSyncs) {
    const syncVersion = extractSyncVersion(serverFile || clientFile || '');

    const clientInputType = serverFile
      ? getSyncClientDataType(serverFile)
      : clientFile
        ? getSyncClientDataType(clientFile)
        : '{ }';

    const serverOutputType = serverFile ? getSyncServerOutputType(serverFile) : '{ }';
    const clientOutputType = clientFile ? getSyncClientOutputType(clientFile) : '{ }';

    console.log(`[TypeMapGenerator] Sync: ${pagePath}/${syncName}/${syncVersion} (server: ${!!serverFile}, client: ${!!clientFile})`);

    if (!syncTypesByPage.has(pagePath)) {
      syncTypesByPage.set(pagePath, new Map());
    }
    syncTypesByPage.get(pagePath)!.set(`${syncName}@${syncVersion}`, { clientInput: clientInputType, serverOutput: serverOutputType, clientOutput: clientOutputType, version: syncVersion });
  }

  const functionsInterface = generateServerFunctions({ namedImports, defaultImports });

  const { content, docsData } = buildTypeMapArtifacts({
    typesByPage,
    syncTypesByPage,
    namedImports,
    defaultImports,
    functionsInterface,
  });

  writeTypeMapArtifacts({ content, docsData });
};
