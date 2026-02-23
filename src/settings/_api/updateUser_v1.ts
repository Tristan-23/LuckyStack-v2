import { AuthProps, SessionLayout } from '../../../config';
import { Functions, ApiResponse } from '../../../src/_sockets/apiTypes.generated';
import sharp from 'sharp';
import path from 'path';
import { UPLOADS_DIR } from '../../../server/utils/paths';

export const rateLimit: number | false = 20;
export const httpMethod: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'POST';

export const auth: AuthProps = {
  login: true,
  additional: []
};

export interface ApiParams {
  data: {
    name?: string;
    theme?: 'light' | 'dark';
    language?: string;
    avatar?: string;
  };
  user: SessionLayout;
  functions: Functions;
}

export const main = async ({ data, user, functions }: ApiParams): Promise<ApiResponse> => {

  const { avatar, name, theme, language } = data;

  if (avatar) {
    const matches = avatar.match(/^data:(.+);base64,(.+)$/);
    if (matches) {
      const base64Data = matches[2];
      const buffer = Buffer.from(base64Data, "base64");

      const fileName = `${user.id}.webp`;
      const filePath = path.join(UPLOADS_DIR, fileName);

      try {
        await sharp(buffer)
          .webp({ quality: 80 })
          .toFile(filePath);

        console.log(`✅ Avatar saved for ${user.name} at ${filePath}`);
      } catch (err) {
        console.error("Error saving avatar:", err);
        return { status: "error", errorCode: 'avatar.uploadFailed' };
      }
    } else {
      console.log("failed to upload new avatar")
      return { status: "error", errorCode: 'avatar.invalidFormat' };
    }
  }

  let newData = {};

  if (avatar) newData = { ...newData, avatar: `${user.id}` }
  if (name) newData = { ...newData, name }
  if (theme) newData = { ...newData, theme }
  if (language) newData = { ...newData, language }

  if (!user.token) return { status: 'error', errorCode: 'session.invalid' }

  await functions.db.prisma.user.update({
    where: { id: user.id },
    data: newData
  })

  await functions.session.saveSession(user.token, { ...user, ...newData });

  return { status: 'success', result: {} }
};
