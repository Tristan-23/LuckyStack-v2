import { AuthProps, SessionLayout } from '../../../config';
import { Functions, ApiResponse } from '../../../src/_sockets/apiTypes.generated';
import { User } from '../test2/_types/user';
// Set the request limit per minute. Set to false to use the default config value config.rateLimiting
export const rateLimit: number | false = 20;

// HTTP method for this API. If not set, inferred from name (get* = GET, delete* = DELETE, else POST)
export const httpMethod: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'POST';

export const auth: AuthProps = {
  login: true,
  additional: []
};

export interface ApiParams {
  data: User;
  user: SessionLayout;
  functions: Functions;
}

export const main = async ({  }: ApiParams): Promise<ApiResponse> => {
  // Error responses must include errorCode
  // return { status: 'error', errorCode: 'api.someError', errorParams: [{ key: 'id', value: 1 }] };

  // Optional: set custom HTTP status on this response
  // return { status: 'success', httpStatus: 201 };

  return {
    status: 'success',
    // Your response data here
  };
};