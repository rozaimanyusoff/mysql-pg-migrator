import path from 'path';

function resolveUploadDir(): string {
  const dir = process.env.UPLOAD_DIR;
  if (!dir) return path.join(process.cwd(), 'public', 'uploads');
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
}

export const UPLOAD_DIR = resolveUploadDir();
export const LOGS_DIR = path.join(UPLOAD_DIR, 'logs');
export const CONFIG_DIR = path.join(UPLOAD_DIR, 'config');
