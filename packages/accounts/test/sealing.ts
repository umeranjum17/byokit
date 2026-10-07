// Test-only authenticated sealing; the ephemeral key never leaves the test run (a child process is handed its parent's).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
export const key = process.env.SEAL_KEY ? Buffer.from(process.env.SEAL_KEY, 'hex') : randomBytes(32);
export const sealing = {
  encryptString(text: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  },
  decryptString(data: Buffer) {
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  },
};
