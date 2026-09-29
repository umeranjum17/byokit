// The shared shape every backend implements.
export interface Keystore {
  /** The secret, or null when no entry exists under this name. */
  get(name: string): Promise<string | null>;
  set(name: string, secret: string): Promise<void>;
  /** True when an entry existed and is now gone. */
  delete(name: string): Promise<boolean>;
}
