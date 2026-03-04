import fs from "fs";
import path from "path";
import { createRequire } from 'module';
import tryCatch from "../functions/tryCatch";
import { getInputTypeFromFile, getSyncClientDataType } from './typeMap/extractors';
import { invalidateProgramCache } from './typeMap/tsProgram';
import { SERVER_FUNCTIONS_DIR, SRC_DIR } from '../utils/paths';
import { clearRuntimeTypeResolverCache } from '../utils/runtimeTypeResolver';

const nodeRequire = createRequire(import.meta.url);

export const devApis: Record<string, any> = {};
export const devSyncs: Record<string, any> = {};
export const devFunctions: Record<string, any> = {};

const API_VERSION_REGEX = /_v(\d+)$/;
const SYNC_VERSION_REGEX = /_(server|client)_v(\d+)$/;

export const initializeAll = async () => {
  await Promise.all([initializeApis(), initializeSyncs(), initializeFunctions()]);
};

const importFile = async (absolutePath: string) => {
  const normalizedPath = absolutePath.replace(/\\/g, '/');

  for (const cacheKey of Object.keys(nodeRequire.cache)) {
    const normalizedCacheKey = cacheKey.replace(/\\/g, '/');
    if (normalizedCacheKey.startsWith(normalizedPath)) {
      delete nodeRequire.cache[cacheKey];
    }
  }

  return nodeRequire(absolutePath);
};

const collectTsFiles = (dir: string, relativeTo = ""): string[] => {
  const results: string[] = [];
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    const relPath = relativeTo ? `${relativeTo}/${entry}` : entry;
    if (fs.statSync(entryPath).isDirectory()) {
      results.push(...collectTsFiles(entryPath, relPath));
    } else if (entry.endsWith(".ts")) {
      results.push(relPath);
    }
  }
  return results;
};

const isMergeable = (value: unknown): value is Record<string, unknown> | ((...args: any[]) => any) => {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
};

const resolveFunctionModule = (loadedModule: any, fileName: string) => {
  if (!loadedModule || typeof loadedModule !== 'object' || !("default" in loadedModule)) {
    return isMergeable(loadedModule) ? loadedModule : {};
  }

  const moduleRecord = loadedModule as Record<string, any>;
  const { default: defaultExport, ...namedExports } = moduleRecord;
  const filteredNamedExports = Object.fromEntries(
    Object.entries(namedExports).filter(([key]) => key !== '__esModule')
  );

  if (Object.keys(filteredNamedExports).length > 0) {
    return filteredNamedExports;
  }

  if (defaultExport !== undefined) {
    return { [fileName]: defaultExport };
  }

  return {};
};

export const initializeApis = async () => {
  Object.keys(devApis).forEach((key) => delete devApis[key]);
  invalidateProgramCache();
  clearRuntimeTypeResolverCache();
  const srcFolder = fs.readdirSync(SRC_DIR);

  for (const file of srcFolder) {
    await scanApiFolder(file);
  }
};

const scanApiFolder = async (file: string, basePath = "") => {
  const fullPath = path.join(SRC_DIR, basePath, file);
  if (!fs.statSync(fullPath).isDirectory()) return;

  if (!file.toLowerCase().endsWith("api")) {
    const subFolders = fs.readdirSync(fullPath);
    for (const sub of subFolders) {
      await scanApiFolder(sub, path.join(basePath, file));
    }
    return;
  }

  const pageLocation = basePath.replace(/\\/g, '/');
  const tsFiles = collectTsFiles(fullPath);

  for (const relFile of tsFiles) {
    const rawApiName = relFile.replace(/\.ts$/, "").replace(/\\/g, '/');
    const versionMatch = rawApiName.match(API_VERSION_REGEX);
    if (!versionMatch) {
      continue;
    }

    const version = `v${versionMatch[1]}`;
    const apiName = rawApiName.replace(API_VERSION_REGEX, '');
    const routeKey = pageLocation
      ? `api/${pageLocation}/${apiName}/${version}`
      : `api/${apiName}/${version}`;

    const modulePath = path.resolve(path.join(fullPath, relFile));
    const [err, module] = await tryCatch(async () => importFile(modulePath));
    if (err) {
      console.log(`[loader][api] failed to import ${routeKey} from ${modulePath}:`, err, 'red');
      continue;
    }

    const resolvedModule = module?.default ? { ...module.default, ...module } : module;
    const { auth = {}, main, rateLimit, httpMethod, schema } = resolvedModule;
    if (!main || typeof main !== "function") continue;
    const inputType = getInputTypeFromFile(modulePath);

    devApis[routeKey] = {
      main,
      auth: {
        login: auth.login || false,
        additional: auth.additional || [],
      },
      rateLimit,
      httpMethod,
      schema,
      inputType,
      inputTypeFilePath: modulePath,
    };
  }
};

export const initializeSyncs = async () => {
  Object.keys(devSyncs).forEach((key) => delete devSyncs[key]);
  invalidateProgramCache();
  clearRuntimeTypeResolverCache();
  const srcFolder = fs.readdirSync(SRC_DIR);

  for (const file of srcFolder) {
    await scanSyncFolder(file);
  }
};

const scanSyncFolder = async (file: string, basePath = "") => {
  const fullPath = path.join(SRC_DIR, basePath, file);
  if (!fs.statSync(fullPath).isDirectory()) return;

  if (!file.toLowerCase().endsWith("sync")) {
    const subFolders = fs.readdirSync(fullPath);
    for (const sub of subFolders) {
      await scanSyncFolder(sub, path.join(basePath, file));
    }
    return;
  }

  const pageLocation = basePath.replace(/\\/g, '/');
  const tsFiles = collectTsFiles(fullPath);

  for (const relFile of tsFiles) {
    const rawSyncFileName = relFile.replace(/\.ts$/, "").replace(/\\/g, '/');
    const syncMatch = rawSyncFileName.match(SYNC_VERSION_REGEX);
    if (!syncMatch) {
      continue;
    }

    const kind = syncMatch[1];
    const version = `v${syncMatch[2]}`;
    const syncName = rawSyncFileName.replace(SYNC_VERSION_REGEX, '');
    const routeBaseKey = pageLocation
      ? `sync/${pageLocation}/${syncName}/${version}`
      : `sync/${syncName}/${version}`;

    const filePath = path.resolve(path.join(fullPath, relFile));
    const [fileError, fileResult] = await tryCatch(async () => importFile(filePath));
    if (fileError) {
      console.log(`[loader][sync] failed to import ${filePath}:`, fileError, 'red');
      continue;
    }

    const resolvedSyncModule = fileResult?.default
      ? { ...fileResult.default, ...fileResult }
      : fileResult;
    const inputType = getSyncClientDataType(filePath);

    if (kind === 'server') {
      devSyncs[`${routeBaseKey}_server`] = {
        main: resolvedSyncModule.main,
        auth: resolvedSyncModule.auth || {},
        inputType,
        inputTypeFilePath: filePath,
      };
    } else {
      devSyncs[`${routeBaseKey}_client`] = resolvedSyncModule.main;
    }
  }
};

export const initializeFunctions = async () => {
  Object.keys(devFunctions).forEach((key) => delete devFunctions[key]);

  const serverFunctionsDir = SERVER_FUNCTIONS_DIR;
  if (fs.existsSync(serverFunctionsDir)) {
    await scanFunctionsFolder(serverFunctionsDir);
  }
};

const scanFunctionsFolder = async (dir: string, basePath: string[] = []) => {
  const entries = fs.readdirSync(dir);

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      await scanFunctionsFolder(fullPath, [...basePath, entry]);
      continue;
    }

    if (!entry.endsWith(".ts")) {
      continue;
    }

    const [err, module] = await tryCatch(async () => importFile(fullPath));
    if (err) {
      console.log(`[loader][function] failed to import ${fullPath}:`, err, 'red');
      continue;
    }

    const fileName = entry.replace(".ts", "");
    const resolvedFunctionModule = resolveFunctionModule(module, fileName);
    if (!isMergeable(resolvedFunctionModule)) continue;

    let target = devFunctions;
    for (const part of basePath) {
      if (!target[part]) target[part] = {};
      target = target[part];
    }

    if (target[fileName] && isMergeable(resolvedFunctionModule) && isMergeable(target[fileName])) {
      Object.assign(resolvedFunctionModule, target[fileName]);
    }

    target[fileName] = resolvedFunctionModule;
  }
};
