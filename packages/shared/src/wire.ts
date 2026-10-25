export interface PreKeyBundleWireT {
  registrationId: number;
  deviceId: string;
  identityKey: string;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  oneTimePreKey?: { keyId: number; publicKey: string } | null;
}
