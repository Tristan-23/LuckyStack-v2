import { devSyncs, devFunctions } from "../dev/loader";
import { syncs, functions } from '../prod/generatedApis';
import { ioInstance } from "./socket";
import { getSession } from "../functions/session";
import { SessionLayout } from "../../config";
import { validateRequest } from "../utils/validateRequest";
import { extractTokenFromSocket } from "../utils/extractToken";
import tryCatch from "../../shared/tryCatch";
import { extractLanguageFromHeader, normalizeErrorResponse } from "../utils/responseNormalizer";
import { validateInputByType } from '../utils/runtimeTypeValidation';

interface HttpSyncRequestParams {
  name: string;
  cb?: string;
  data: Record<string, any>;
  receiver: string;
  ignoreSelf?: boolean;
  token: string | null;
  xLanguageHeader?: string | string[];
  acceptLanguageHeader?: string | string[];
}

type HttpSyncResponse = {
  status: 'success' | 'error';
  message: string;
  errorCode?: string;
  errorParams?: { key: string; value: string | number | boolean; }[];
  httpStatus?: number;
};

const functionsObject = process.env.NODE_ENV == 'development' ? devFunctions : functions;

export default async function handleHttpSyncRequest({
  name,
  cb,
  data,
  receiver,
  ignoreSelf,
  token,
  xLanguageHeader,
  acceptLanguageHeader,
}: HttpSyncRequestParams): Promise<HttpSyncResponse> {
  const preferredLocale =
    extractLanguageFromHeader(xLanguageHeader)
    || extractLanguageFromHeader(acceptLanguageHeader);
  const user = await getSession(token);

  const buildSyncError = ({
    response,
    preferred,
    userLanguage,
  }: {
    response: { status: 'error'; errorCode?: string; errorParams?: { key: string; value: string | number | boolean; }[]; httpStatus?: number };
    preferred?: string | null;
    userLanguage?: string | null;
  }): HttpSyncResponse => {
    const normalized = normalizeErrorResponse({
      response,
      preferredLocale: preferred,
      userLanguage,
    });

    return {
      status: normalized.status,
      message: normalized.message,
      errorCode: normalized.errorCode,
      errorParams: normalized.errorParams,
      httpStatus: normalized.httpStatus,
    };
  };

  const ensureSyncErrorShape = (response: { status: 'error'; errorCode?: string; errorParams?: { key: string; value: string | number | boolean; }[]; httpStatus?: number }) => {
    if (typeof response.errorCode === 'string' && response.errorCode.trim().length > 0) {
      return response;
    }

    return {
      ...response,
      errorCode: 'sync.clientRejected',
    };
  };

  if (!ioInstance) {
    return buildSyncError({
      response: { status: 'error', errorCode: 'sync.ioUnavailable' },
      preferred: preferredLocale,
      userLanguage: user?.language,
    });
  }

  if (!name || typeof name !== 'string') {
    return buildSyncError({
      response: { status: 'error', errorCode: 'sync.invalidRequest' },
      preferred: preferredLocale,
      userLanguage: user?.language,
    });
  }

  if (!receiver || typeof receiver !== 'string') {
    return buildSyncError({
      response: { status: 'error', errorCode: 'sync.missingReceiver' },
      preferred: preferredLocale,
      userLanguage: user?.language,
    });
  }

  const syncObject = process.env.NODE_ENV == 'development' ? devSyncs : syncs;
  const nameSegments = name.split('/').filter(Boolean);
  const syncBaseName = nameSegments[nameSegments.length - 2];
  const requestedVersion = nameSegments[nameSegments.length - 1];
  const callbackName = typeof cb === 'string' && cb.trim().length > 0
    ? cb.trim()
    : `${syncBaseName}/${requestedVersion}`;

  let resolvedName = name;
  if (!syncObject[`${name}_client`] && !syncObject[`${name}_server`] && syncBaseName && requestedVersion) {
    const rootKey = `sync/${syncBaseName}/${requestedVersion}`;
    if (syncObject[`${rootKey}_client`] || syncObject[`${rootKey}_server`]) {
      resolvedName = rootKey;
    }
  }

  if (!syncObject[`${resolvedName}_client`] && !syncObject[`${resolvedName}_server`]) {
    return buildSyncError({
      response: { status: 'error', errorCode: 'sync.notFound' },
      preferred: preferredLocale,
      userLanguage: user?.language,
    });
  }

  let serverOutput = {};
  if (syncObject[`${resolvedName}_server`]) {
    const { auth, main: serverMain, inputType, inputTypeFilePath } = syncObject[`${resolvedName}_server`];

    const inputValidation = validateInputByType({
      typeText: inputType,
      value: data,
      rootKey: 'clientInput',
      filePath: inputTypeFilePath,
    });
    if (inputValidation.status === 'error') {
      return buildSyncError({
        response: {
          status: 'error',
          errorCode: 'sync.invalidInputType',
          errorParams: [{ key: 'message', value: inputValidation.message }],
        },
        preferred: preferredLocale,
        userLanguage: user?.language,
      });
    }

    if (auth.login && !user?.id) {
      return buildSyncError({
        response: { status: 'error', errorCode: 'auth.required' },
        preferred: preferredLocale,
      });
    }

    const validationResult = validateRequest({ auth, user: user as SessionLayout });
    if (validationResult.status === 'error') {
      return buildSyncError({
        response: {
          status: 'error',
          errorCode: validationResult.errorCode || 'auth.forbidden',
          errorParams: validationResult.errorParams,
          httpStatus: validationResult.httpStatus,
        },
        preferred: preferredLocale,
        userLanguage: user?.language,
      });
    }

    const [serverSyncError, serverSyncResult] = await tryCatch(async () => await serverMain({ clientInput: data, user, functions: functionsObject, roomCode: receiver }));
    if (serverSyncError) {
      return buildSyncError({
        response: { status: 'error', errorCode: 'sync.serverExecutionFailed' },
        preferred: preferredLocale,
        userLanguage: user?.language,
      });
    }

    if (serverSyncResult?.status == 'error') {
      return buildSyncError({
        response: serverSyncResult,
        preferred: preferredLocale,
        userLanguage: user?.language,
      });
    }

    if (serverSyncResult?.status !== 'success') {
      return buildSyncError({
        response: { status: 'error', errorCode: 'sync.invalidServerResponse' },
        preferred: preferredLocale,
        userLanguage: user?.language,
      });
    }

    serverOutput = serverSyncResult;
  }

  const sockets = receiver === 'all'
    ? ioInstance.sockets.sockets
    : ioInstance.sockets.adapter.rooms.get(receiver);

  if (!sockets) {
    return buildSyncError({
      response: { status: 'error', errorCode: 'sync.noReceiversFound' },
      preferred: preferredLocale,
      userLanguage: user?.language,
    });
  }

  for (const socketEntry of sockets) {
    const tempSocket = receiver === 'all'
      ? (socketEntry as [string, any])[1]
      : ioInstance.sockets.sockets.get(socketEntry as string);

    if (!tempSocket) continue;

    const tempToken = extractTokenFromSocket(tempSocket);
    const targetUser = await getSession(tempToken);

    if (ignoreSelf && token && token === tempToken) {
      continue;
    }

    if (syncObject[`${resolvedName}_client`]) {
      const [clientSyncError, clientSyncResult] = await tryCatch(async () => await syncObject[`${resolvedName}_client`]({ clientInput: data, user: targetUser, functions: functionsObject, serverOutput, roomCode: receiver }));
      if (clientSyncError) {
        tempSocket.emit('sync', {
          cb: callbackName,
          fullName: resolvedName,
          ...buildSyncError({
            response: { status: 'error', errorCode: 'sync.clientExecutionFailed' },
            preferred: extractLanguageFromHeader(tempSocket.handshake.headers['accept-language'] || tempSocket.handshake.headers['x-language']),
            userLanguage: targetUser?.language,
          }),
        });
        continue;
      }

      if (clientSyncResult?.status === 'error') {
        tempSocket.emit('sync', {
          cb: callbackName,
          fullName: resolvedName,
          ...buildSyncError({
            response: ensureSyncErrorShape(clientSyncResult),
            preferred: extractLanguageFromHeader(tempSocket.handshake.headers['accept-language'] || tempSocket.handshake.headers['x-language']),
            userLanguage: targetUser?.language,
          }),
        });
        continue;
      }

      if (clientSyncResult?.status !== 'success') {
        tempSocket.emit('sync', {
          cb: callbackName,
          fullName: resolvedName,
          ...buildSyncError({
            response: { status: 'error', errorCode: 'sync.invalidClientResponse' },
            preferred: extractLanguageFromHeader(tempSocket.handshake.headers['accept-language'] || tempSocket.handshake.headers['x-language']),
            userLanguage: targetUser?.language,
          }),
        });
        continue;
      }

      tempSocket.emit('sync', {
        cb: callbackName,
        fullName: resolvedName,
        serverOutput,
        clientOutput: clientSyncResult,
        message: clientSyncResult.message || `${name} sync success`,
        status: 'success',
      });
      continue;
    }

    tempSocket.emit('sync', {
      cb: callbackName,
      fullName: resolvedName,
      serverOutput,
      clientOutput: {},
      message: `${name} sync success`,
      status: 'success',
    });
  }

  return { status: 'success', message: `sync ${name} success` };
}
