import { apis, functions } from '../prod/generatedApis'
import { devApis, devFunctions } from "../dev/loader"
import { apiMessage } from './socket';
import { getSession } from '../functions/session';
import config, { SessionLayout } from '../../config';
import { Socket } from 'socket.io';
import { logout } from './utils/logout';
import { validateRequest } from '../utils/validateRequest';
import { captureException } from '../functions/sentry';
import { checkRateLimit } from '../utils/rateLimiter';
import tryCatch from '../../shared/tryCatch';
import { defaultHttpStatusForResponse, extractLanguageFromHeader, normalizeErrorResponse } from '../utils/responseNormalizer';
import { validateInputByType } from '../utils/runtimeTypeValidation';

type handleApiRequestType = {
  msg: apiMessage,
  socket: Socket,
  token: string | null,
}

export default async function handleApiRequest({ msg, socket, token }: handleApiRequestType) {
  //? This event gets triggered when the client uses the apiRequest function
  //? We validate the message, check auth then execute

  if (typeof msg != 'object') {
    console.log('socket message was not a json object!!!!', 'red')
    return;
  }

  const { name, data, responseIndex } = msg;
  const user = await getSession(token)
  const preferredLocale =
    extractLanguageFromHeader(socket.handshake.headers['x-language'])
    || extractLanguageFromHeader(socket.handshake.headers['accept-language']);

  const emitApiError = ({
    response,
    fallbackHttpStatus,
  }: {
    response: { status: 'error'; httpStatus?: number; errorCode?: string; errorParams?: { key: string; value: string | number | boolean; }[] };
    fallbackHttpStatus?: number;
  }) => {
    return socket.emit(`apiResponse-${responseIndex}`, normalizeErrorResponse({
      response,
      preferredLocale,
      userLanguage: user?.language,
      fallbackHttpStatus,
    }));
  };

  if (!responseIndex && typeof responseIndex !== 'number') {
    console.log('no response index given!!!!', 'red')
    return;
  }

  //? 'logout' needs special handling since it requires socket access
  // Extract the API name (last segment) to check for logout regardless of page path
  const nameSegments = name.split('/').filter(Boolean);
  const requestedVersion = nameSegments[nameSegments.length - 1];
  const apiBaseName = nameSegments[nameSegments.length - 2];
  if (apiBaseName == 'logout') {
    await logout({ token, socket, userId: user?.id || null });
    return socket.emit(`apiResponse-${responseIndex}`, {
      status: 'success',
      httpStatus: 200,
      result: true,
    });
  }

  //? Built-in API handlers

  if (!name || !data || typeof name != 'string' || typeof data != 'object') {
    return emitApiError({
      response: {
        status: 'error',
        errorCode: 'api.invalidRequest',
      },
      fallbackHttpStatus: 400,
    });
  }

  console.log(`api: ${name} called`, 'blue');

  const isDevMode = process.env.NODE_ENV !== 'production';
  const apisObject = isDevMode ? devApis : apis;

  //? Resolve API: try exact match first, then fall back to root-level
  //? e.g. client sends "api/examples/session" → not found → try "api/session"
  let resolvedName = name;
  if (!apisObject[name] && apiBaseName && requestedVersion) {
    const rootKey = `api/${apiBaseName}/${requestedVersion}`;
    if (apisObject[rootKey]) {
      resolvedName = rootKey;
    }
  }

  //? Check if API exists
  if (!apisObject[resolvedName]) {
    return emitApiError({
      response: {
        status: 'error',
        errorCode: 'api.notFound',
        errorParams: [{ key: 'name', value: name }],
      },
      fallbackHttpStatus: 404,
    });
  }

  const { auth, main } = apisObject[resolvedName];
  const inputType = apisObject[resolvedName].inputType as string | undefined;
  const inputTypeFilePath = apisObject[resolvedName].inputTypeFilePath as string | undefined;

  const inputValidation = validateInputByType({
    typeText: inputType,
    value: data,
    rootKey: 'data',
    filePath: inputTypeFilePath,
  });
  if (inputValidation.status === 'error') {
    return emitApiError({
      response: {
        status: 'error',
        errorCode: 'api.invalidInputType',
        errorParams: [{ key: 'message', value: inputValidation.message }],
      },
      fallbackHttpStatus: 400,
    });
  }

  //? Auth validation: check login requirement
  if (auth.login) {
    if (!user?.id) {
      console.log(`ERROR: API ${name} requires login`, 'red');
      return emitApiError({
        response: { status: 'error', errorCode: 'auth.required' },
        fallbackHttpStatus: 401,
      });
    }
  }

  //? Auth validation: check additional requirements
  const authResult = validateRequest({ auth, user: user as SessionLayout });
  if (authResult.status === "error") {
    console.log(`ERROR: Auth failed for ${name}: ${authResult.errorCode}`, 'red');
    return emitApiError({
      response: {
        status: 'error',
        errorCode: authResult.errorCode || 'auth.forbidden',
        errorParams: authResult.errorParams,
        httpStatus: authResult.httpStatus,
      },
      fallbackHttpStatus: authResult.httpStatus ?? 403,
    });
  }

  //? Rate limiting check
  const apiRateLimit = apisObject[resolvedName].rateLimit;
  const effectiveLimit = apiRateLimit !== undefined
    ? apiRateLimit
    : config.rateLimiting.defaultApiLimit;

  if (effectiveLimit !== false && effectiveLimit > 0) {
    const rateLimitKey = user?.id
      ? `user:${user.id}:api:${name}`
      : `ip:${socket.handshake.address}:api:${name}`;

    const { allowed, resetIn } = checkRateLimit({
      key: rateLimitKey,
      limit: effectiveLimit,
      windowMs: config.rateLimiting.windowMs
    });

    if (!allowed) {
      console.log(`Rate limit exceeded for ${name}`, 'yellow');
      return emitApiError({
        response: {
          status: 'error',
          errorCode: 'api.rateLimitExceeded',
          errorParams: [{ key: 'seconds', value: resetIn }],
        },
        fallbackHttpStatus: 429,
      });
    }
  }

  //? Execute the API handler
  const functionsObject = isDevMode ? devFunctions : functions;
  const [error, result] = await tryCatch(
    async () => await main({ data, user, functions: functionsObject })
  );

  if (error) {
    console.log(`ERROR in ${name}:`, error, 'red');
    captureException(error, { api: name, userId: user?.id });
    socket.emit(`apiResponse-${responseIndex}`, normalizeErrorResponse({
      response: {
        status: 'error',
        errorCode: 'api.internalServerError',
      },
      preferredLocale,
      userLanguage: user?.language,
      fallbackHttpStatus: 500,
    }));
  } else if (result !== undefined && result !== null) {
    console.log(`api: ${name} completed`, 'blue');

    if (result && typeof result === 'object' && (result.status === 'success' || result.status === 'error')) {
      if (result.status === 'error') {
        socket.emit(`apiResponse-${responseIndex}`, normalizeErrorResponse({
          response: result,
          preferredLocale,
          userLanguage: user?.language,
          fallbackHttpStatus: defaultHttpStatusForResponse({
            status: 'error',
            explicitHttpStatus: typeof result.httpStatus === 'number' ? result.httpStatus : undefined,
          }),
        }));
      } else {
        socket.emit(`apiResponse-${responseIndex}`, {
          ...result,
          status: 'success',
          httpStatus: defaultHttpStatusForResponse({
            status: 'success',
            explicitHttpStatus: typeof result.httpStatus === 'number' ? result.httpStatus : undefined,
          }),
        });
      }
    } else {
      socket.emit(`apiResponse-${responseIndex}`, normalizeErrorResponse({
        response: {
          status: 'error',
          errorCode: 'api.invalidResponseStatus',
        },
        preferredLocale,
        userLanguage: user?.language,
        fallbackHttpStatus: 500,
      }));
    }
  } else {
    console.log(`WARNING: ${name} returned nothing`, 'yellow');
    socket.emit(`apiResponse-${responseIndex}`, normalizeErrorResponse({
      response: {
        status: 'error',
        errorCode: 'api.emptyResponse',
      },
      preferredLocale,
      userLanguage: user?.language,
      fallbackHttpStatus: 500,
    }));
  }
}