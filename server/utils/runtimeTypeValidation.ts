import {
  getUnresolvedTypeMessage,
  isUnresolvedTypeMarker,
  resolveRuntimeTypeText,
} from './runtimeTypeResolver';

type ValidationResult =
  | { status: 'success' }
  | { status: 'error'; message: string };

const splitTopLevel = (value: string, splitter: '|' | '&'): string[] => {
  const items: string[] = [];
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let token = '';

  for (const char of value) {
    if (char === '(') depthParen += 1;
    if (char === ')') depthParen -= 1;
    if (char === '{') depthBrace += 1;
    if (char === '}') depthBrace -= 1;
    if (char === '[') depthBracket += 1;
    if (char === ']') depthBracket -= 1;

    if (char === splitter && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      items.push(token.trim());
      token = '';
      continue;
    }

    token += char;
  }

  if (token.trim()) items.push(token.trim());
  return items;
};

const parseObjectFields = (typeText: string): Array<{ key: string; optional: boolean; type: string }> => {
  const clean = typeText.trim();
  if (!clean.startsWith('{') || !clean.endsWith('}')) return [];

  const inner = clean.slice(1, -1);
  const fields: Array<{ key: string; optional: boolean; type: string }> = [];

  let part = '';
  let depth = 0;
  for (const char of inner) {
    if (char === '{' || char === '[' || char === '(') depth += 1;
    if (char === '}' || char === ']' || char === ')') depth -= 1;

    if (char === ';' && depth === 0) {
      const trimmed = part.trim();
      if (trimmed) {
        const match = trimmed.match(/^(\w+)(\?)?\s*:\s*(.+)$/);
        if (match) {
          fields.push({ key: match[1], optional: Boolean(match[2]), type: match[3].trim() });
        }
      }
      part = '';
      continue;
    }

    part += char;
  }

  const final = part.trim();
  if (final) {
    const match = final.match(/^(\w+)(\?)?\s*:\s*(.+)$/);
    if (match) {
      fields.push({ key: match[1], optional: Boolean(match[2]), type: match[3].trim() });
    }
  }

  return fields;
};

const isPrimitiveMatch = (type: string, value: unknown): boolean => {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  if (type === 'undefined') return value === undefined;
  if (type === 'Date') return typeof value === 'string' || value instanceof Date;
  return false;
};

const isPrimitiveType = (type: string): boolean => {
  return ['string', 'number', 'boolean', 'null', 'undefined', 'Date'].includes(type);
};

const validateType = (typeText: string, value: unknown, path: string): ValidationResult => {
  const type = typeText.trim();

  if (isUnresolvedTypeMarker(type)) {
    return { status: 'error', message: `${path}: ${getUnresolvedTypeMessage(type)}` };
  }

  if (type.startsWith('(') && type.endsWith(')')) {
    return validateType(type.slice(1, -1), value, path);
  }

  if (type.includes('|')) {
    const unionParts = splitTopLevel(type, '|').filter(Boolean);
    if (unionParts.length > 1) {
      for (const unionType of unionParts) {
        const result = validateType(unionType, value, path);
        if (result.status === 'success') return result;
      }
      return { status: 'error', message: `${path} does not match union type ${type}` };
    }
  }

  if (type.includes('&')) {
    const intersectionParts = splitTopLevel(type, '&').filter(Boolean);
    if (intersectionParts.length > 1) {
      for (const intersectionType of intersectionParts) {
        const result = validateType(intersectionType, value, path);
        if (result.status === 'error') return result;
      }
      return { status: 'success' };
    }
  }

  if (type.endsWith('[]')) {
    if (!Array.isArray(value)) {
      return { status: 'error', message: `${path} should be an array` };
    }
    const itemType = type.slice(0, -2).trim();
    if (itemType === type) {
      return { status: 'success' };
    }
    for (let index = 0; index < value.length; index += 1) {
      const result = validateType(itemType, value[index], `${path}[${index}]`);
      if (result.status === 'error') return result;
    }
    return { status: 'success' };
  }

  if ((type.startsWith("'") && type.endsWith("'")) || (type.startsWith('"') && type.endsWith('"'))) {
    const literal = type.slice(1, -1);
    return value === literal
      ? { status: 'success' }
      : { status: 'error', message: `${path} should equal ${literal}` };
  }

  if (isPrimitiveMatch(type, value)) {
    return { status: 'success' };
  }

  if (isPrimitiveType(type)) {
    const expectedType = type === 'Date' ? 'Date (ISO string or Date)' : type;
    return { status: 'error', message: `${path} should be ${expectedType}` };
  }

  if (type === 'any' || type === 'unknown') {
    return { status: 'success' };
  }

  if (/^Record<.+>$/.test(type)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return { status: 'success' };
    }
    return { status: 'error', message: `${path} should be an object` };
  }

  if (type.startsWith('{') && type.endsWith('}')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { status: 'error', message: `${path} should be an object` };
    }

    const fields = parseObjectFields(type);
    const input = value as Record<string, unknown>;

    for (const field of fields) {
      const fieldValue = input[field.key];
      if (fieldValue === undefined) {
        if (field.optional) continue;
        return { status: 'error', message: `${path}.${field.key} is required` };
      }

      const result = validateType(field.type, fieldValue, `${path}.${field.key}`);
      if (result.status === 'error') return result;
    }

    const allowedKeys = new Set(fields.map((field) => field.key));
    for (const key of Object.keys(input)) {
      if (!allowedKeys.has(key)) {
        return { status: 'error', message: `${path}.${key} is not allowed` };
      }
    }

    return { status: 'success' };
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*(?:<.+>)?$/.test(type)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*<.+>$/.test(type)) {
      return { status: 'error', message: `${path}: unresolved utility ${type}` };
    }

    return { status: 'error', message: `${path}: unresolved type ${type}` };
  }

  return { status: 'success' };
};

export const validateInputByType = ({
  typeText,
  value,
  rootKey,
  filePath,
}: {
  typeText?: string;
  value: unknown;
  rootKey: string;
  filePath?: string;
}): ValidationResult => {
  if (!typeText || typeText.trim() === '' || typeText.trim() === 'any') {
    return { status: 'success' };
  }

  const resolvedType = resolveRuntimeTypeText({ typeText, filePath });
  if (resolvedType.status === 'error') {
    return { status: 'error', message: `${rootKey}: ${resolvedType.message}` };
  }

  return validateType(resolvedType.typeText, value, rootKey);
};
