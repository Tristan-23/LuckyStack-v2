import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isWorkspaceRoot = (candidate: string): boolean => {
	return (
		fs.existsSync(path.join(candidate, 'package.json'))
		&& (
			fs.existsSync(path.join(candidate, 'tsconfig.json'))
			|| fs.existsSync(path.join(candidate, 'tsconfig.server.json'))
		)
	);
};

const findWorkspaceRoot = (startDir: string): string | null => {
	let current = path.resolve(startDir);

	while (true) {
		if (isWorkspaceRoot(current)) return current;

		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
};

export const ROOT_DIR =
	findWorkspaceRoot(process.cwd())
	|| findWorkspaceRoot(__dirname)
	|| process.cwd();
export const SRC_DIR = path.join(ROOT_DIR, 'src');
export const SERVER_DIR = path.join(ROOT_DIR, 'server');
export const SHARED_DIR = path.join(ROOT_DIR, 'shared');

export const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const SERVER_FUNCTIONS_DIR = path.join(SERVER_DIR, 'functions');

export const GENERATED_SOCKET_TYPES_PATH = path.join(SRC_DIR, '_sockets', 'apiTypes.generated.ts');
export const GENERATED_API_DOCS_PATH = path.join(SRC_DIR, 'docs', 'apiDocs.generated.json');

export const TSCONFIG_ALIAS_FILES = ['tsconfig.server.json', 'tsconfig.app.json'];

export const resolveFromRoot = (...segments: string[]): string => path.join(ROOT_DIR, ...segments);