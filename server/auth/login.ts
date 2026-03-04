import dotenv from 'dotenv';
import oauthProviders from "./loginConfig";
import { IncomingMessage, ServerResponse } from 'http';
import { URLSearchParams } from 'url';
import { prisma } from '../functions/db';
import { PROVIDERS } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { saveSession } from "../functions/session"
import validator from "validator"
import config, { SessionLayout } from '../../config';
import path from 'path';
import { existsSync } from 'fs';
import tryCatch from '../../shared/tryCatch';
import { UPLOADS_DIR } from '../utils/paths';

dotenv.config();

type paramsType = {
  email?: string,
  password?: string,
  name?: string,
  confirmPassword?: string,
}

const uploadsFolder = UPLOADS_DIR;

const asRecord = (value: unknown): Record<string, any> => {
  if (value && typeof value === 'object') {
    return value as Record<string, any>;
  }
  return {};
};

// Route that starts the OAuth flow for the specified provider and redirects to the callback endpoint
const loginWithCredentials = async (params: paramsType) => {

  const email = validator.escape(params.email || '');
  const password = validator.escape(params.password || '');
  const name = params.name ? validator.escape(params.name) : undefined;
  const confirmPassword = params.confirmPassword ? validator.escape(params.confirmPassword) : undefined;

  console.log(name, email, password, confirmPassword)

  if (!email || !password) { return { status: false, reason: 'login.empty' }; }
  if (email.length > 191) { return { status: false, reason: 'login.emailCharacterLimit' }; }
  if (password.length < 8) { return { status: false, reason: 'login.passwordCharacterMinimum' }; }
  if (password.length > 191) { return { status: false, reason: 'login.passwordCharacterLimit' }; }
  if (name && name.length > 191) { return { status: false, reason: 'login.nameCharacterLimit' }; }
  if (!validator.isEmail(email)) { return { status: false, reason: 'login.invalidEmailFormat' }; }

  if (name && confirmPassword) { //? register
    if (password != confirmPassword) { return { status: false, reason: 'login.passwordNotMatch' }; }

    const checkEmail = async () => {
      return await prisma.user.findFirst({
        where: {
          email: email,
          provider: PROVIDERS.credentials
        },
      })
    }

    //? check if email already exists
    const [checkEmailError, checkEmailResponse] = await tryCatch(checkEmail);
    if (checkEmailError) {
      console.log(checkEmailError);
      return { status: false, reason: checkEmailError };
    }
    if (checkEmailResponse) { return { status: false, reason: 'login.emailExist' }; }

    //? email is not in use so we define the function to create the new user
    const createNewUser = async () => {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      return await prisma.user.create({
        data: {
          email: email,
          provider: PROVIDERS.credentials,
          name: name,
          password: hashedPassword,
          avatar: '',
          avatarFallback: `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`,
          admin: false,
          language: config.defaultLanguage
        }
      })
    }

    //? here we create the new user
    const [createNewUserError, createNewUserResponse] = await tryCatch(createNewUser);
    if (createNewUserError) { return { status: false, reason: createNewUserError }; }
    if (createNewUserResponse) { return { status: true, reason: 'login.userCreated', session: createNewUserResponse }; }
    return { status: false, reason: 'login.createUserFailed' };

  } else { //? login
    //? here we define the function to find the user
    const findUser = async () => {
      return await prisma.user.findFirst({
        where: {
          email: email,
          provider: PROVIDERS.credentials
        }
      })
    }

    //? attempt to find the user
    const [findUserError, findUserResponse] = await tryCatch(findUser);
    if (findUserError) {
      console.log(findUserError, ' findUserError');
      return { status: false, reason: findUserError };
    }
    if (!findUserResponse) { return { status: false, reason: 'login.userNotFound' }; }

    //? if we found a user we check if the password matches the hashed one in the db
    const checkPassword = async () => { return await bcrypt.compare(password, findUserResponse.password as string); }
    const [checkPasswordError, checkPasswordResponse] = await tryCatch(checkPassword);
    if (checkPasswordError) {
      console.log(checkPasswordError, ' checkPasswordError');
      return { status: false, reason: checkPasswordError };
    }
    if (!checkPasswordResponse) { return { status: false, reason: 'login.wrongPassword' }; }

    //? if the password matches we return the user
    if (checkPasswordResponse) {
      const newToken = randomBytes(32).toString("hex")
      // const newUser = {
      //   id: findUserResponse.id,
      //   name: findUserResponse.name,
      //   provider: 'credentials',
      //   email: findUserResponse.email,
      //   createdAt: findUserResponse.createdAt,
      //   updatedAt: findUserResponse.updatedAt,
      //   token: newToken,
      //   avatar: findUserResponse.avatar || '',
      //   avatarFallback: `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`,
      //   admin: findUserResponse.admin,
      //   language: findUserResponse.language,
      //   theme: findUserResponse.theme
      // };
      const newUser = {
        ...findUserResponse,
        token: newToken,
      }
          

      const filePath = path.join(uploadsFolder, `${newUser.id}.webp`);
      if (existsSync(filePath)) {
        newUser.avatar = `${newUser.id}.webp`;
      }

      await saveSession(newToken, newUser, true);
      console.log(newUser);
      return { status: true, reason: 'login.loggedIn', newToken, session: newUser };
    }
  }
}

// Route that handles the callback from the OAuth provider
const loginCallback = async (pathname: string, req: IncomingMessage, _res: ServerResponse) => {
  //? check if provider exists
  const providerName = pathname.split('/')[3]; // Extract the provider (google/github)
  const provider = oauthProviders.find(p => p.name === providerName);
  if (!provider || !req.url) { return false }
  if (!('clientID' in provider)) { return }

  const queryString = req.url.split('?')[1]; // Get the part after '?'
  const params = new URLSearchParams(queryString);
  const code = params.get('code');

  //? if no code provided in the url we return false (the code is used to get the access token and should be provided by the oauth provider)
  if (!code || code == '') {
    console.log('no code provided in callback url')
    return false
  }

  const values = {
    code,
    client_id: provider.clientID,
    client_secret: provider.clientSecret,
    redirect_uri: provider.callbackURL,
    grant_type: 'authorization_code'
  }

  //? with the code we can get the access token
  const getToken = async () => {
    if (provider.tokenExchangeMethod == 'json') {
      const url = provider.tokenExchangeURL;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(values),
      })
      return await response.json();
    } else if (provider.tokenExchangeMethod == 'form') {
      const url = provider.tokenExchangeURL;
      const params = new URLSearchParams();
      params.append('client_id', provider.clientID);
      params.append('client_secret', provider.clientSecret);
      params.append('code', values.code);
      params.append('grant_type', 'authorization_code');
      params.append('redirect_uri', provider.callbackURL);

      console.log(params)
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: params.toString()
      });

      return await response.json();
    }
  }

  const [getTokenError, getTokenResponse] = await tryCatch(getToken)
  if (getTokenError) {
    console.log(getTokenError, 'getTokenError');
    return false;
  }

  //? here we get the access token
  const tokenData = asRecord(getTokenResponse);
  const access_token = typeof tokenData.access_token === 'string' ? tokenData.access_token : '';
  if (!access_token) {
    console.log('no access token found in oauth token response');
    return false;
  }
  const getUserData = async () => {
    // const url = `${provider.userInfoURL}?alt=json&access_token=${access_token}`;
    const url = provider.userInfoURL;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${access_token}`
      },
    })
    return await response.json();
  }

  //? with the access_token token we get the user data 
  const [getUserDataError, getUserDataResponse] = await tryCatch(getUserData);
  if (getUserDataError) {
    console.log(getUserDataError);
    return false;
  }

  const userData = asRecord(getUserDataResponse);

  const name: string = String(userData[provider.nameKey] || 'didnt find a name')

  const emailValue = userData[provider.emailKey];
  let email: string | undefined = typeof emailValue === 'string' ? emailValue : undefined;
  const avatarId = provider.avatarCodeKey ? userData[provider.avatarCodeKey] : undefined;
  const avatar: string =
    provider?.avatarKey ? String(userData[provider.avatarKey] || '') :
      provider.getAvatar ? provider.getAvatar({ userData, avatarId: typeof avatarId === 'string' ? avatarId : '' }) : '';

  //? if we didnt find the email we try to get it with a external link if this one is provided
  if (!email && provider.getEmail) {
    const selectedEmail = await provider.getEmail(access_token);

    if (!selectedEmail) {
      console.log('no email found');
      return false;
    }

    email = selectedEmail;
  }

  let tempUser: SessionLayout | undefined;
  if (email) {
    const fetchUser = async () => {
      return await prisma.user.findFirst({
        where: {
          email: email,
          provider: provider.name as PROVIDERS
        }
      })
    }

    //? here we check if the user exists in the db
    const [userDataError, userDataResponse] = await tryCatch(fetchUser);
    if (userDataError) {
      console.log(userDataError);
      return false;
    }

    console.log('ASDSADASDDASDA')
    //? if the user exists we assign it to the tempUser variable
    if (userDataResponse?.id) {
      // const { password, ...safeData } = userDataResponse;
      const filePath = path.join(uploadsFolder, `${userDataResponse.id}.webp`);
      if (existsSync(filePath)) {
        userDataResponse.avatar = `${userDataResponse.id}.webp`;
      }

      tempUser = {
        ...userDataResponse,
        token: ''
      };
    }

    //? if the user doesnt exist we create a new one
    if (!tempUser) {
      const createNewUser = async () => {
        if (!email) { return false; }
        return await prisma.user.create({
          data: {
            email,
            provider: provider.name as PROVIDERS,
            name,
            avatar,
            avatarFallback: `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`,
            language: config.defaultLanguage
          }
        })
      }
      const [createNewUserError, createNewUserResponse] = await tryCatch(createNewUser);
      if (createNewUserError) {
        console.log(createNewUserError);
        return false;
      }

      if (createNewUserResponse) {
        tempUser = {
          ...createNewUserResponse,
          token: ''
        };
      }
    }
  }

  if (!tempUser) {
    return false;
  }

  //? here we create a new token, create the users session and return the token as a sign of success
  const newToken = randomBytes(32).toString("hex")
  // user.id = tempUser.id;
  // user.createdAt = tempUser.createdAt;
  // user.updatedAt = tempUser.updatedAt;
  // user.token = newToken;
  // user.admin = tempUser.admin
  // user.language = config.defaultLanguage;
  // if (tempUser.avatar) { user.avatar = tempUser.avatar; }


  tempUser.token = newToken;
  await saveSession(newToken, tempUser, true);
  console.log(tempUser)
  return newToken;
}

export { loginWithCredentials, loginCallback }