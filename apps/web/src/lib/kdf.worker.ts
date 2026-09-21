import { argon2id } from "@noble/hashes/argon2.js";
self.onmessage = (event: MessageEvent<{ password: string; salt: Uint8Array }>) => {
  const password = new TextEncoder().encode(event.data.password);
  try {
    const key = argon2id(password, event.data.salt, { m: 65536, t: 3, p: 1, dkLen: 32 });
    self.postMessage({ key });
    key.fill(0);
  } catch {
    self.postMessage({ error: true });
  } finally {
    password.fill(0);
    event.data.password = "";
  }
};
