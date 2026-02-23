import { apis, functions } from '../prod/generatedApis';
import { devApis, devFunctions } from '../dev/loader';
import { getSession } from '../functions/session';
import config, { SessionLayout } from '../../config';
import { validateRequest } from '../utils/validateRequest';
import { captureException } from '../functions/sentry';
import { checkRateLimit } from '../utils/rateLimiter';
import { inferHttpMethod, HttpMethod } from '../utils/httpApiUtils';
import tryCatch from '../../shared/tryCatch';
import { defaultHttpStatusForResponse, extractLanguageFromHeader, normalizeErrorResponse } from '../utils/responseNormalizer';
import { validateInputByType } from '../utils/runtimeTypeValidation';

/**
 * HTTP API Request Handler
 * 
 * Handles API requests coming via HTTP (instead of WebSocket).
 * Reuses existing API handlers but returns results as HTTP response.
 * 
 * Payload format:
 * ```json
 * {
 *   "name": "api/examples/publicApi",
 *   "data": { "message": "hello" }
 * }
 * ```
 * 
 * @example
 * ```typescript
 * // In server.ts
 * if (pathname.startsWith('/api/')) {
 *   const token = extractTokenFromRequest(req);
 *   const body = await parseJsonBody(req);
 *   const result = await handleHttpApiRequest({ name: body.name, data: body.data, token });
 *   res.end(JSON.stringify(result));
 * }
 * ```
 */

interface HttpApiRequestParams {
  name: string;
  data: Record<string, any>;
  token: string | null;
  xLanguageHeader?: string | string[];
  acceptLanguageHeader?: string | string[];
  /** HTTP method from the request */
  method?: HttpMethod;
}

type ApiNetworkResponse<T = any> =
  | ({ status: 'success'; httpStatus: number } & T)
  | {
    status: 'error';
    httpStatus: number;
    message: string;
    errorCode: string;
    errorParams?: {
      key: string;
      value: string | number | boolean;
    }[];
  };

export async function handleHttpApiRequest({
  name,
  data,
  token,
  xLanguageHeader,
  acceptLanguageHeader,
  method = 'POST'
}: HttpApiRequestParams): Promise<ApiNetworkResponse> {

  const normalizedName = name.startsWith('api/') ? name : `api/${name}`;

  const preferredLocale =
    extractLanguageFromHeader(xLanguageHeader)
    || extractLanguageFromHeader(acceptLanguageHeader);
  const user = await getSession(token);

  const buildNetworkError = ({
    response,
    fallbackHttpStatus,
  }: {
    response: { status: 'error'; httpStatus?: number; errorCode?: string; errorParams?: { key: string; value: string | number | boolean; }[] };
    fallbackHttpStatus?: number;
  }): ApiNetworkResponse => {
    return normalizeErrorResponse({
      response,
      preferredLocale,
      userLanguage: user?.language,
      fallbackHttpStatus,
    }) as ApiNetworkResponse;
  };

  // Validate request format
  if (!name || typeof name !== 'string') {
    return buildNetworkError({
      response: { status: 'error', errorCode: 'api.invalidName' },
      fallbackHttpStatus: 400,
    });
  }

  if (data && typeof data !== 'object') {
    return buildNetworkError({
      response: { status: 'error', errorCode: 'api.invalidDataObject' },
      fallbackHttpStatus: 400,
    });
  }

  const requestData = data || {};

  console.log(`http api: ${normalizedName} called`, 'cyan');

  const isDevMode = process.env.NODE_ENV !== 'production';
  const apisObject = isDevMode ? devApis : apis;

  //? Resolve API: try exact match first, then fall back to root-level
  //? e.g. "api/examples/session" → not found → try "api/session"
  const nameSegments = normalizedName.split('/').filter(Boolean);
  const requestedVersion = nameSegments[nameSegments.length - 1];
  const apiBaseName = nameSegments[nameSegments.length - 2];
  let resolvedName = normalizedName;
  if (!apisObject[normalizedName] && apiBaseName && requestedVersion) {
    const rootKey = `api/${apiBaseName}/${requestedVersion}`;
    if (apisObject[rootKey]) {
      resolvedName = rootKey;
    }
  }

  // Check if API exists
  if (!apisObject[resolvedName]) {
    return buildNetworkError({
      response: {
        status: 'error',
        errorCode: 'api.notFound',
        errorParams: [{ key: 'name', value: normalizedName }],
      },
      fallbackHttpStatus: 404,
    });
  }

  const { auth, main, httpMethod: declaredMethod } = apisObject[resolvedName];
  const inputType = apisObject[resolvedName].inputType as string | undefined;
  const inputTypeFilePath = apisObject[resolvedName].inputTypeFilePath as string | undefined;

  const inputValidation = validateInputByType({
    typeText: inputType,
    value: requestData,
    rootKey: 'data',
    filePath: inputTypeFilePath,
  });
  if (inputValidation.status === 'error') {
    return buildNetworkError({
      response: {
        status: 'error',
        errorCode: 'api.invalidInputType',
        errorParams: [{ key: 'message', value: inputValidation.message }],
      },
      fallbackHttpStatus: 400,
    });
  }

  // HTTP method validation
  const expectedMethod = declaredMethod ?? inferHttpMethod(resolvedName);
  if (method !== expectedMethod) {
    console.log(`Method mismatch for ${normalizedName}: expected ${expectedMethod}, got ${method}`, 'yellow');
    return buildNetworkError({
      response: {
        status: 'error',
        errorCode: 'api.methodNotAllowed',
        errorParams: [{ key: 'method', value: expectedMethod }],
      },
      fallbackHttpStatus: 405,
    });
  }

  // Auth validation: check login requirement
  if (auth?.login) {
    if (!user?.id) {
      console.log(`ERROR: HTTP API ${name} requires login`, 'red');
      return buildNetworkError({
        response: { status: 'error', errorCode: 'auth.required' },
        fallbackHttpStatus: 401,
      });
    }
  }

  // Auth validation: check additional requirements
  const authResult = validateRequest({ auth, user: user as SessionLayout });
  if (authResult.status === 'error') {
    console.log(`ERROR: Auth failed for HTTP API ${name}: ${authResult.errorCode}`, 'red');
    return buildNetworkError({
      response: {
        status: 'error',
        errorCode: authResult.errorCode || 'auth.forbidden',
        errorParams: authResult.errorParams,
        httpStatus: authResult.httpStatus,
      },
      fallbackHttpStatus: authResult.httpStatus ?? 403,
    });
  }

  // Rate limiting check
  const apiRateLimit = apisObject[resolvedName].rateLimit;
  const effectiveLimit = apiRateLimit !== undefined
    ? apiRateLimit
    : config.rateLimiting.defaultApiLimit;

  if (effectiveLimit !== false && effectiveLimit > 0) {
    // For HTTP, we use token-based key or fall back to a generic "http" key
    const rateLimitKey = user?.id
      ? `user:${user.id}:api:${name}`
      : `http:api:${normalizedName}`;

    const { allowed, resetIn } = checkRateLimit({
      key: rateLimitKey,
      limit: effectiveLimit,
      windowMs: config.rateLimiting.windowMs
    });

    if (!allowed) {
      console.log(`Rate limit exceeded for HTTP API ${normalizedName}`, 'yellow');
      return buildNetworkError({
        response: {
          status: 'error',
          errorCode: 'api.rateLimitExceeded',
          errorParams: [{ key: 'seconds', value: resetIn }],
        },
        fallbackHttpStatus: 429,
      });
    }
  }

  // Execute the API handler
  const functionsObject = isDevMode ? devFunctions : functions;
  const [error, result] = await tryCatch(
    async () => await main({ data: requestData, user, functions: functionsObject })
  );

  if (error) {
    console.log(`ERROR in HTTP API ${normalizedName}:`, error, 'red');
    captureException(error, { api: normalizedName, userId: user?.id, source: 'http' });
    return buildNetworkError({
      response: { status: 'error', errorCode: 'api.internalServerError' },
      fallbackHttpStatus: 500,
    });
  }

  if (result !== undefined && result !== null) {
    console.log(`http api: ${normalizedName} completed`, 'cyan');

    // Check if result is already formatted as ApiResponse
    if (result && typeof result === 'object' && (result.status === 'success' || result.status === 'error')) {
      if (result.status === 'error') {
        return buildNetworkError({
          response: result,
          fallbackHttpStatus: defaultHttpStatusForResponse({
            status: 'error',
            explicitHttpStatus: typeof result.httpStatus === 'number' ? result.httpStatus : undefined,
          }),
        });
      }

      return {
        ...result,
        status: 'success',
        httpStatus: defaultHttpStatusForResponse({
          status: 'success',
          explicitHttpStatus: typeof result.httpStatus === 'number' ? result.httpStatus : undefined,
        }),
      } as ApiNetworkResponse;
    }

    return buildNetworkError({
      response: { status: 'error', errorCode: 'api.invalidResponseStatus' },
      fallbackHttpStatus: 500,
    });
  }

  console.log(`WARNING: HTTP API ${normalizedName} returned nothing`, 'yellow');
  return buildNetworkError({
    response: { status: 'error', errorCode: 'api.emptyResponse' },
    fallbackHttpStatus: 500,
  });
}
