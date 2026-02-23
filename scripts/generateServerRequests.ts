import fs from "fs";
import path from "path";
import { getInputTypeFromFile, getSyncClientDataType } from '../server/dev/typeMap/extractors';
import { resolveFromRoot } from '../server/utils/paths';

const normalizePath = (p: string) => p.split(path.sep).join("/");
const API_VERSION_REGEX = /_v(\d+)$/;
const SYNC_VERSION_REGEX = /_(server|client)_v(\d+)$/;

// Recursively walk dirs to collect _api and _sync files
const walkSrcFiles = (dir: string, results: string[] = []) => {
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      walkSrcFiles(fullPath, results);
    } else if (file.endsWith(".ts") && (fullPath.includes("_api") || fullPath.includes("_sync"))) {
      // if (file.endsWith("_client.ts")) continue; // skip client stubs
      results.push(fullPath);
    }
  }
  return results;
};

// Collect function files recursively
const walkFunctionFiles = (dir: string, results: string[] = []) => {
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      walkFunctionFiles(fullPath, results);
    } else if (entry.endsWith(".ts")) {
      results.push(normalizePath(fullPath));
    }
  }

  return results;
};

// --------------------
// Collect files
// --------------------
const rawSrcFiles = walkSrcFiles("./src").map(normalizePath).sort();
const functionFiles = walkFunctionFiles("./server/functions").sort();

// --------------------
// Buckets
// --------------------
const apiImports: string[] = [];
const syncImports: string[] = [];
const functionImports: string[] = [];

let apiMap = "export const apis: Record<string, { auth: any, main: any, rateLimit?: number | false, httpMethod?: 'GET' | 'POST' | 'PUT' | 'DELETE', inputType?: string, inputTypeFilePath?: string }> = {\n";
let syncMap = "export const syncs: Record<string, { main: any, auth: Record<string, any>, inputType?: string, inputTypeFilePath?: string }> | any = {\n";
let functionsMap = "export const functions: Record<string, any> = {\n";

let apiCount = 0;
let syncCount = 0;
let fnCount = 0;

// --------------------
// Process API + Sync
// --------------------
rawSrcFiles.forEach((normalized) => {
  const importPath = "../../" + normalized.replace(/\.ts$/, "");

  // API
  if (normalized.includes("_api/")) {
    const varName = `api${apiCount++}`;
    apiImports.push(`import * as ${varName} from '${importPath}';`);

    // capture optional page path and API name (supports root-level and nested _api)
    // Root: src/_api/session.ts → pagePath=undefined, apiName="session"
    // Nested: src/examples/_api/user/changeName.ts → pagePath="examples", apiName="user/changeName"
    const match = normalized.match(/src\/(?:(.+?)\/)?_api\/(.+)\.ts$/i);
    if (!match) return;
    const [_, pagePath, apiNameWithVersion] = match;
    const versionMatch = apiNameWithVersion.match(API_VERSION_REGEX);
    if (!versionMatch) return;

    const version = `v${versionMatch[1]}`;
    const apiName = apiNameWithVersion.replace(API_VERSION_REGEX, '');
    const routeKey = pagePath ? `api/${pagePath}/${apiName}/${version}` : `api/${apiName}/${version}`;

    apiMap += `  "${routeKey}": {\n    auth: "auth" in ${varName} ? ${varName}.auth : {},\n    main: ${varName}.main,\n    rateLimit: "rateLimit" in ${varName} ? (${varName}.rateLimit as number | false | undefined) : undefined,\n    httpMethod: "httpMethod" in ${varName} ? (${varName}.httpMethod as 'GET' | 'POST' | 'PUT' | 'DELETE' | undefined) : undefined,\n    inputType: ${JSON.stringify(getInputTypeFromFile(normalized))},\n    inputTypeFilePath: ${JSON.stringify(normalized)},\n  },\n`;
  }

  // Sync
  if (normalized.includes("_sync/")) {
    // Make page path optional for root-level _sync
    const match = normalized.match(/src\/(?:(.+?)\/)?_sync\/(.+)\.ts$/i);
    if (!match) return;
    const [_, pagePath, syncNameWithVersion] = match;
    const syncMatch = syncNameWithVersion.match(SYNC_VERSION_REGEX);
    if (!syncMatch) return;

    const kind = syncMatch[1];
    const version = `v${syncMatch[2]}`;
    const syncName = syncNameWithVersion.replace(SYNC_VERSION_REGEX, '');
    const routeKey = pagePath ? `sync/${pagePath}/${syncName}/${version}` : `sync/${syncName}/${version}`;

    console.log(syncName)
    if (kind === 'client') {
      const varName = `syncClient${syncCount++}`;
      syncImports.push(`import * as ${varName} from '${importPath}';`);
      syncMap += `  "${routeKey}_client": ${varName}.main,\n`;
    }

    if (kind === 'server') {
      const varName = `syncServer${syncCount++}`;
      syncImports.push(`import * as ${varName} from '${importPath}';`);
      const inputType = getSyncClientDataType(normalized);
      syncMap += `  "${routeKey}_server": { auth: "auth" in ${varName} ? ${varName}.auth : {}, main: ${varName}.main, inputType: ${JSON.stringify(inputType)}, inputTypeFilePath: ${JSON.stringify(normalized)} },\n`;
    }
  }
});

// --------------------
// Process Functions
// --------------------
functionFiles.forEach((filePath) => {
  const importPath = "../../" + filePath.replace(/\.ts$/, "");
  const varName = `fn${fnCount++}`;
  const fileName = path.basename(filePath, ".ts");
  functionImports.push(`import * as ${varName} from '${importPath}';`);
  functionsMap += `  ${JSON.stringify(fileName)}: (() => {\n`;
  functionsMap += `    const { default: _default, ...named } = ${varName} as Record<string, any>;\n`;
  functionsMap += `    const cleaned = Object.fromEntries(Object.entries(named).filter(([key]) => key !== '__esModule'));\n`;
  functionsMap += `    if (Object.keys(cleaned).length > 0) return cleaned;\n`;
  functionsMap += `    return _default !== undefined ? { ${JSON.stringify(fileName)}: _default } : {};\n`;
  functionsMap += `  })(),\n`;
});

// --------------------
// Close Maps
// --------------------
apiMap += "};\n";
syncMap += "};\n";
functionsMap += "};";

// --------------------
// Final Output
// --------------------
const importStatements = [
  ...apiImports,
  "",
  ...syncImports,
  "",
  ...functionImports,
].join("\n");

const output = `${importStatements}\n\n${apiMap}\n${syncMap}\n${functionsMap}`;

fs.writeFileSync(resolveFromRoot('server', 'prod', 'generatedApis.ts'), output);
console.log("✅ server/prod/generatedApis.ts created");