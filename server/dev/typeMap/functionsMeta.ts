import fs from 'fs';
import path from 'path';
import { FileImport, ImportCollectors, parseFileTypeContext, sanitizeTypeAndCollectImports } from './typeContext';
import { stripComments } from './extractors';
import { SERVER_FUNCTIONS_DIR } from '../../utils/paths';

const extractBalancedParentheses = (content: string, startIndex: number): string | null => {
  let depth = 0;
  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === '(') {
      depth++;
    } else if (content[i] === ')') {
      depth--;
      if (depth === 0) return content.substring(startIndex, i + 1);
    }
  }
  return null;
};

const cleanArgs = (args: string): string => {
  let cleaned = args.replace(/\r?\n/g, ' ');

  const strings: string[] = [];
  cleaned = cleaned.replace(/(['"])(?:(?=(\\?))\2.)*?\1/g, (m) => {
    strings.push(m);
    return `__STR_${strings.length - 1}__`;
  });

  if (cleaned.includes('process.env')) {
    return '...args: any[]';
  }

  cleaned = cleaned.replace(/\s*=(?![>])[^,{})]+/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned.replace(/__STR_(\d+)__/g, (_match, index) => strings[Number(index)] || '');
};

const findDefinitionSignature = (
  name: string,
  content: string,
  filePath: string,
  availableExports: Set<string>,
  fileImports: Map<string, FileImport>,
  collectors: ImportCollectors,
): string => {
  const varRegex = new RegExp(`const\\s+${name}\\s*=\\s*(?:async\\s*)?`);
  const funcRegex = new RegExp(`function\\s+${name}\\s*`);

  let match = content.match(varRegex);
  let isAsync = false;
  let defStart = -1;
  let genericsStr = '';
  const knownGenerics = new Set<string>();

  if (match) {
    defStart = match.index! + match[0].length;
    isAsync = match[0].includes('async');
    const lookAhead = content.substring(defStart, defStart + 50);
    const genMatch = lookAhead.match(/^\s*(<[^>]+>)/);
    if (genMatch) {
      genericsStr = genMatch[1];
      defStart += genMatch[0].length;
    }
  } else {
    match = content.match(funcRegex);
    if (match) {
      defStart = match.index! + match[0].length;
      const prefix = content.substring(Math.max(0, match.index! - 6), match.index!);
      if (prefix.includes('async')) isAsync = true;
      const lookAhead = content.substring(match.index! + match[0].length, match.index! + match[0].length + 50);
      const genMatch = lookAhead.match(/^\s*(<[^>]+>)/);
      if (genMatch) {
        genericsStr = genMatch[1];
        defStart += genMatch[0].length;
      }
    }
  }

  if (genericsStr) {
    const inner = genericsStr.slice(1, -1);
    inner.split(',').forEach(genericPart => {
      const part = genericPart.trim().split(/\s*=/)[0].trim().split(/\s+/)[0];
      if (part) knownGenerics.add(part);
    });
  }

  if (defStart !== -1) {
    const openParen = content.indexOf('(', defStart - 5);
    if (openParen !== -1 && openParen < defStart + 50) {
      const between = content.substring(defStart, openParen);
      const newMatch = between.match(/new\s+([a-zA-Z0-9_]+)/);
      if (newMatch) {
        const className = newMatch[1];
        const sanitized = sanitizeTypeAndCollectImports({
          type: className,
          filePath,
          availableExports,
          fileImports,
          collectors,
        });
        if (sanitized !== 'any') return sanitized;
        return 'any';
      }

      if (!/^\s*$/.test(between)) return 'any';

      const rawArgs = extractBalancedParentheses(content, openParen);
      if (rawArgs) {
        let returnType = isAsync ? 'Promise<any>' : 'any';
        const afterArgs = content.substring(openParen + rawArgs.length);
        const returnMatch = afterArgs.match(/^\s*:\s*([^{=]+)(?:=>|\{)/);
        if (returnMatch) {
          let rawType = returnMatch[1].trim();
          if (rawType.endsWith('=>')) rawType = rawType.slice(0, -2).trim();
          returnType = sanitizeTypeAndCollectImports({
            type: rawType,
            filePath,
            availableExports,
            fileImports,
            knownGenerics,
            collectors,
          });
          if (isAsync && !returnType.startsWith('Promise')) returnType = `Promise<${returnType}>`;
        }

        const cleanedArgs = cleanArgs(rawArgs);
        const sanitizedArgs = sanitizeTypeAndCollectImports({
          type: cleanedArgs,
          filePath,
          availableExports,
          fileImports,
          knownGenerics,
          collectors,
        });
        return `${genericsStr}${sanitizedArgs} => ${returnType}`;
      }
    }
  }

  return 'any';
};

const generateFunctionsForDir = (dir: string, collectors: ImportCollectors, indent: string = '\t'): string => {
  if (!fs.existsSync(dir)) return '';
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let output = '';

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const subOutput = generateFunctionsForDir(fullPath, collectors, indent + '  ');
      if (subOutput.trim()) {
        output += `${indent}${entry.name}: {\n${subOutput}${indent}};\n`;
      }
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      const fileName = entry.name.replace('.ts', '');
      let fileOutput = '';

      try {
        const rawContent = fs.readFileSync(fullPath, 'utf-8');
        const content = stripComments(rawContent);
        const exports = new Map<string, string>();

        const { availableExports, fileImports } = parseFileTypeContext(content);

        const simpleExportRegex = /export\s+(?:const|function|async\s+function)\s+(\w+)/g;
        let match;
        while ((match = simpleExportRegex.exec(content)) !== null) {
          exports.set(match[1], findDefinitionSignature(match[1], content, fullPath, availableExports, fileImports, collectors));
        }

        const exportDefaultMatch = content.match(/export\s+default\s+(.*)/);
        if (exportDefaultMatch) {
          const decl = exportDefaultMatch[1].trim();
          const asMatch = decl.match(/(.*)\s+as\s+([a-zA-Z0-9_]+);?$/);
          if (asMatch) {
            const typeName = asMatch[2];
            const sanitizedType = sanitizeTypeAndCollectImports({
              type: typeName,
              filePath: fullPath,
              availableExports,
              fileImports,
              collectors,
            });
            exports.set('default', sanitizedType !== 'any' ? sanitizedType : 'any');
          } else {
            const defFunc = decl.match(/(?:async\s+)?function\s+(\w+)/);
            if (defFunc) {
              exports.set('default', findDefinitionSignature(defFunc[1], content, fullPath, availableExports, fileImports, collectors));
            } else {
              const defVal = decl.match(/^(\w+)/);
              if (defVal && !decl.startsWith('class')) {
                exports.set('default', findDefinitionSignature(defVal[1], content, fullPath, availableExports, fileImports, collectors));
              } else {
                const isAsync = decl.includes('async');
                exports.set('default', `(...args: any[]) => ${isAsync ? 'Promise<any>' : 'any'}`);
              }
            }
          }
        }

        const exportBlockRegex = /export\s*\{([^}]+)\}/g;
        while ((match = exportBlockRegex.exec(content)) !== null) {
          match[1].split(',').forEach(part => {
            const parts = part.trim().split(/\s+as\s+/);
            const name = parts[0];
            const alias = parts[1] || name;
            if (name) exports.set(alias, findDefinitionSignature(name, content, fullPath, availableExports, fileImports, collectors));
          });
        }

        const defaultSig = exports.get('default');
        if (defaultSig) {
          exports.delete('default');
        }

        for (const [name, sig] of exports) {
          fileOutput += `${indent}  ${name}: ${sig};\n`;
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
  }

  return output;
};

export const generateServerFunctions = (collectors: ImportCollectors): string => {
  const functionsDir = SERVER_FUNCTIONS_DIR;
  return generateFunctionsForDir(functionsDir, collectors, '\t');
};
