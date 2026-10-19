import { relayProfileBase } from "./relay-profile";

/** No fallback or migration: development keys never read the stable partition. */
export function createProfileStorage(storage: Storage, prefix: string): Storage {
  const keys = (): string[] => {
    const result: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && key.startsWith(prefix)) result.push(key.slice(prefix.length));
    }
    return result;
  };
  const methods = {
    getItem: (key: string) => storage.getItem(prefix + String(key)),
    setItem: (key: string, value: string) => storage.setItem(prefix + String(key), String(value)),
    removeItem: (key: string) => storage.removeItem(prefix + String(key)),
    clear: () => {
      // Snapshot only this partition before removals change the backing indices.
      for (const key of keys()) storage.removeItem(prefix + key);
    },
    key: (index: number) => keys()[Number(index) >>> 0] ?? null,
  };
  const target = Object.create(Storage.prototype) as Storage;
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(target, name, { value: method, configurable: true });
  }
  Object.defineProperty(target, "length", { get: () => keys().length, configurable: true });
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property !== "string" || property in object) return Reflect.get(object, property, receiver);
      return methods.getItem(property) ?? undefined;
    },
    set(_object, property, value) {
      if (typeof property !== "string" || property in target) return false;
      methods.setItem(property, String(value));
      return true;
    },
    deleteProperty(_object, property) {
      if (typeof property !== "string" || property in target) return false;
      methods.removeItem(property);
      return true;
    },
    has(object, property) {
      return property in object || (typeof property === "string" && methods.getItem(property) !== null);
    },
    ownKeys: keys,
    getOwnPropertyDescriptor(object, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(object, property);
      if (descriptor) return descriptor;
      if (typeof property !== "string") return undefined;
      const value = methods.getItem(property);
      return value === null ? undefined : { value, writable: true, enumerable: true, configurable: true };
    },
    defineProperty(_object, property, descriptor) {
      if (typeof property !== "string" || property in target || !("value" in descriptor)
        || descriptor.configurable !== true) return false;
      methods.setItem(property, String(descriptor.value));
      return true;
    },
    preventExtensions: () => false,
  });
}

// This side-effect module runs before all application imports. Window and
// globalThis share the replacement, including bare localStorage and libraries.
if (typeof window !== "undefined") {
  const pathname = window.location.pathname;
  if (pathname === "/.ccgui-dev") throw new Error("Invalid development relay profile route");
  const profile = relayProfileBase(pathname);
  if (profile) {
    const storage = window.localStorage;
    const prefix = `ccgui-profile:${profile}:`;
    const partition = createProfileStorage(storage, prefix);
    // Failure aborts module evaluation/boot; never continue with raw storage.
    Object.defineProperty(window, "localStorage", { get: () => partition, configurable: false });
    Object.defineProperty(window, "__ccguiStorageProfile", { value: profile });
    window.addEventListener("storage", (event) => {
      // Our mapped events use the facade; sessionStorage events stay unchanged.
      if (event.storageArea !== storage) return;
      event.stopImmediatePropagation();
      // A native origin-wide clear has no profile provenance. Suppress it too;
      // this facade's clear emits individual, prefixed removals to other tabs.
      if (event.key === null || !event.key.startsWith(prefix)) return;
      const mapped = new StorageEvent("storage", {
        key: event.key.slice(prefix.length),
        oldValue: event.oldValue,
        newValue: event.newValue,
        url: event.url,
      });
      // StorageEventInit's Storage brand check rejects a Proxy. Expose the
      // facade through an own property so listeners cannot recover raw storage.
      Object.defineProperty(mapped, "storageArea", { value: partition });
      window.dispatchEvent(mapped);
    }, true);
  }
}
