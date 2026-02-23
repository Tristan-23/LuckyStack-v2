import { devSyncs, devFunctions } from "../dev/loader"
import { syncs, functions } from '../prod/generatedApis'
import { ioInstance, syncMessage } from "./socket";
import { Socket } from "socket.io";
import { getSession } from "../functions/session";
import { SessionLayout } from "../../config";
import { validateRequest } from "../utils/validateRequest";
import { extractTokenFromSocket } from "../utils/extractToken";
import tryCatch from "../../shared/tryCatch";
import { extractLanguageFromHeader, normalizeErrorResponse } from "../utils/responseNormalizer";
import { validateInputByType } from "../utils/runtimeTypeValidation";

const functionsObject = process.env.NODE_ENV == 'development' ? devFunctions : functions;


// export default async function handleSyncRequest({ name, clientData, user, serverOutput, roomCode }: syncMessage) {
export default async function handleSyncRequest({ msg, socket, token }: {
  msg: syncMessage,
  socket: Socket,
  token: string | null,
}) {

  if (!ioInstance) { return; }

  //? first we validate the data
  if (typeof msg != 'object') {
    console.log('message', 'socket message was not a json object', 'red')
    const normalized = normalizeErrorResponse({
      response: { status: 'error', errorCode: 'sync.invalidRequest' },
      preferredLocale:
        extractLanguageFromHeader(socket.handshake.headers['x-language'])
        || extractLanguageFromHeader(socket.handshake.headers['accept-language']),
    });
    return socket.emit('sync', {
      status: normalized.status,
      message: normalized.message,
      errorCode: normalized.errorCode,
      errorParams: normalized.errorParams,
      httpStatus: normalized.httpStatus,
    });
  }

  const { name, data, cb, receiver, responseIndex, ignoreSelf } = msg;
  const preferredLocale =
    extractLanguageFromHeader(socket.handshake.headers['x-language'])
    || extractLanguageFromHeader(socket.handshake.headers['accept-language']);

  const buildSyncError = ({
    response,
    preferred,
    userLanguage,
  }: {
    response: { status: 'error'; errorCode?: string; errorParams?: { key: string; value: string | number | boolean; }[]; httpStatus?: number };
    preferred?: string | null;
    userLanguage?: string | null;
  }) => {
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

  if (!name || !data || typeof name != 'string' || typeof data != 'object') {
    return typeof responseIndex == 'number' && socket.emit(`sync-${responseIndex}`, buildSyncError({
      response: { status: 'error', errorCode: 'sync.invalidRequest' },
      preferred: preferredLocale,
    }))
  }

  if (!cb || typeof cb != 'string') {
    return typeof responseIndex == 'number' && socket.emit(`sync-${responseIndex}`, buildSyncError({
      response: { status: 'error', errorCode: 'sync.invalidCallback' },
      preferred: preferredLocale,
    }));
  }

  if (!receiver) {
    console.log('receiver / roomCode: ', receiver, 'red')
    return typeof responseIndex == 'number' && socket.emit(`sync-${responseIndex}`, buildSyncError({
      response: { status: 'error', errorCode: 'sync.missingReceiver' },
      preferred: preferredLocale,
    }));
  }

  console.log(' ', 'blue')
  console.log(' ', 'blue')
  console.log(`sync: ${name} called`, 'blue');

  const user = await getSession(token);
  const syncObject = process.env.NODE_ENV == 'development' ? devSyncs : syncs;
  const nameSegments = name.split('/').filter(Boolean);
  const syncBaseName = nameSegments[nameSegments.length - 2];
  const requestedVersion = nameSegments[nameSegments.length - 1];

  //? Resolve sync: try exact match first, then fall back to root-level
  //? e.g. client sends "sync/examples/updateCounter/v1" → not found → try "sync/updateCounter/v1"
  let resolvedName = name;
  if (!syncObject[`${name}_client`] && !syncObject[`${name}_server`] && syncBaseName && requestedVersion) {
    const rootKey = `sync/${syncBaseName}/${requestedVersion}`;
    if (syncObject[`${rootKey}_client`] || syncObject[`${rootKey}_server`]) {
      resolvedName = rootKey;
    }
  }

  //? we check if there is a client file or/and a server file, if they both dont exist we abort
  if (!syncObject[`${resolvedName}_client`] && !syncObject[`${resolvedName}_server`]) {
    console.log("ERROR!!!, ", `you need ${name}_client or ${name}_server file to sync`, 'red');
    return typeof responseIndex == 'number' && socket.emit(`sync-${responseIndex}`, buildSyncError({
      response: { status: 'error', errorCode: 'sync.notFound' },
      preferred: preferredLocale,
      userLanguage: user?.language,
    }));
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
      return typeof responseIndex == 'number' && socket.emit(`sync-${responseIndex}`, buildSyncError({
        response: {
          status: 'error',
          errorCode: 'sync.invalidInputType',
          errorParams: [{ key: 'message', value: inputValidation.message }],
        },
        preferred: preferredLocale,
        userLanguage: user?.language,
      }));
    }

    //? if the login key is true we check if the user has an id in the session object
    if (auth.login) {
      if (!user?.id) {
        console.log(`ERROR!!!, not logged in but sync requires login`, 'red');
        return typeof responseIndex == 'number' && socket.emit(`sync-${responseIndex}`, buildSyncError({
          response: { status: 'error', errorCode: 'auth.required' },
          preferred: preferredLocale,
        }));
      }
    }

    const validationResult = validateRequest({ auth, user: user as SessionLayout });
    if (validationResult.status === 'error') {
      console.log('ERROR!!!, ', validationResult.errorCode, 'red');
      return typeof responseIndex == 'number' && socket.emit(`sync-${responseIndex}`, buildSyncError({
        response: {
          status: 'error',
          errorCode: validationResult.errorCode || 'auth.forbidden',
          errorParams: validationResult.errorParams,
          httpStatus: validationResult.httpStatus,
        },
        preferred: preferredLocale,
        userLanguage: user?.language,
      }));
    }

    //? if the user has passed all the checks we call the preload sync function and return the result
    const [serverSyncError, serverSyncResult] = await tryCatch(async () => await serverMain({ clientInput: data, user, functions: functionsObject, roomCode: receiver }));
    if (serverSyncError) {
      console.log('ERROR!!!, ', serverSyncError.message, 'red');
      return typeof responseIndex == 'number' && socket.emit(`sync-${responseIndex}`, buildSyncError({
        response: { status: 'error', errorCode: 'sync.serverExecutionFailed' },
        preferred: preferredLocale,
        userLanguage: user?.language,
      }));
    } else if (serverSyncResult?.status == 'error') {
      const normalizedServerError = buildSyncError({
        response: serverSyncResult,
        preferred: preferredLocale,
        userLanguage: user?.language,
      });
      console.log('ERROR!!!, ', normalizedServerError.message, 'red');
      return typeof responseIndex == 'number' && socket.emit(`sync-${responseIndex}`, normalizedServerError);
    } else if (serverSyncResult?.status !== 'success') {
      //? badReturn means it doesnt include a status key with the value 'success' || 'error'
      console.log('ERROR!!!, ', `sync ${resolvedName}_server function didnt return a status key with the value 'success' or 'error'`, 'red');
      return typeof responseIndex == 'number' && socket.emit(`sync-${responseIndex}`, buildSyncError({
        response: { status: 'error', errorCode: 'sync.invalidServerResponse' },
        preferred: preferredLocale,
        userLanguage: user?.language,
      }));
    } else if (serverSyncResult?.status == 'success') {
      serverOutput = serverSyncResult;
    }
  }

  //? from here on we can assume that we have either called a server sync and got a proper result of we didnt call a server sync

  //? get the desired sockets based on the receiver key
  const sockets = receiver === 'all'
    ? ioInstance.sockets.sockets //? all connected sockets (Map)
    : ioInstance.sockets.adapter.rooms.get(receiver) //? Set of socket IDs in room

  //? now we check if we found any sockets
  if (!sockets) {
    console.log('data: ', msg, 'red');
    console.log('receiver: ', receiver, 'red');
    console.log('no sockets found', 'red');
    return typeof responseIndex == 'number' && socket.emit(`sync-${responseIndex}`, buildSyncError({
      response: { status: 'error', errorCode: 'sync.noReceiversFound' },
      preferred: preferredLocale,
      userLanguage: user?.language,
    }));
  }

  //? here we loop over all the connected clients
  //? we keep track of an counter and await the loop every 100 iterations to avoid the server running out of memory and crashing
  let tempCount = 1;
  for (const socketEntry of sockets) {
    tempCount++;
    if (tempCount % 100 == 0) { await new Promise(resolve => setTimeout(resolve, 1)); }

    const tempSocket = receiver === 'all'
      ? (socketEntry as [string, Socket])[1] //? Map entry
      : ioInstance.sockets.sockets.get(socketEntry as string); //? socket ID from Set

    if (!tempSocket) { continue; }

    //? check if they have a token stored in their cookie or session based on the settings
    const tempToken = extractTokenFromSocket(tempSocket);

    //? here we get the users session of the client and run the sync function with the data and the users session data
    const user = await getSession(tempToken);

    if (ignoreSelf && typeof ignoreSelf == 'boolean') {
      if (token == tempToken) {
        continue;
      }
    }

    if (syncObject[`${resolvedName}_client`]) {
      const [clientSyncError, clientSyncResult] = await tryCatch(async () => await syncObject[`${resolvedName}_client`]({ clientInput: data, user, functions: functionsObject, serverOutput, roomCode: receiver }));
      if (clientSyncError) {
        tempSocket.emit(`sync`, {
          cb,
          fullName: resolvedName,
          ...buildSyncError({
            response: { status: 'error', errorCode: 'sync.clientExecutionFailed' },
            preferred:
              extractLanguageFromHeader(tempSocket.handshake.headers['x-language'])
              || extractLanguageFromHeader(tempSocket.handshake.headers['accept-language']),
            userLanguage: user?.language,
          }),
        });
        continue;
      }
      if (clientSyncResult?.status == 'error') {
        tempSocket.emit(`sync`, {
          cb,
          fullName: resolvedName,
          ...buildSyncError({
            response: ensureSyncErrorShape(clientSyncResult),
            preferred:
              extractLanguageFromHeader(tempSocket.handshake.headers['x-language'])
              || extractLanguageFromHeader(tempSocket.handshake.headers['accept-language']),
            userLanguage: user?.language,
          }),
        });
        continue;
      }
      if (clientSyncResult?.status !== 'success') {
        tempSocket.emit(`sync`, {
          cb,
          fullName: resolvedName,
          ...buildSyncError({
            response: { status: 'error', errorCode: 'sync.invalidClientResponse' },
            preferred:
              extractLanguageFromHeader(tempSocket.handshake.headers['x-language'])
              || extractLanguageFromHeader(tempSocket.handshake.headers['accept-language']),
            userLanguage: user?.language,
          }),
        });
        continue;
      }
      else if (clientSyncResult?.status == 'success') {
        const result = {
          cb,
          fullName: resolvedName,
          serverOutput,
          clientOutput: clientSyncResult,  // Return from _client file (success only)
          message: clientSyncResult.message || `${name} sync success`,
          status: 'success'
        };
        console.log(result, 'blue')
        tempSocket.emit(`sync`, result);
      }
    } else {
      //? if there is no client function we still want to send the server data to the clients
      const result = {
        cb,
        fullName: resolvedName,
        serverOutput,
        clientOutput: {},  // No client file, so empty output
        message: `${name} sync success`,
        status: 'success'
      };
      console.log(result, 'blue')
      tempSocket.emit(`sync`, result);
    }
  }

  return typeof responseIndex == 'number' && socket.emit(`sync-${responseIndex}`, { status: 'success', message: `sync ${name} success` });
}