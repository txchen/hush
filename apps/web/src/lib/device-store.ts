export type BrowserDevice = { vaultId: string; deviceId: string; privateKey: CryptoKey };
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("hush-device", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("keys", { keyPath: "vaultId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Browser storage unavailable"));
  });
}
export async function storedDevice(vaultId: string): Promise<BrowserDevice | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("keys").objectStore("keys").get(vaultId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Could not read device key"));
    });
  } finally {
    db.close();
  }
}
export async function saveDevice(device: BrowserDevice) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      tx.objectStore("keys").put(device);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error("Could not save device key"));
      tx.onabort = () => reject(new Error("Could not save device key"));
    });
  } finally {
    db.close();
  }
}
export async function forgetDevice(vaultId: string) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      tx.objectStore("keys").delete(vaultId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error("Could not remove device key"));
    });
  } finally {
    db.close();
  }
}
