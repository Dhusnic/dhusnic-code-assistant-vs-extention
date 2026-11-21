/**
 * Public keys the extension accepts update signatures from. The private half of each lives only on the build machine
 * (%USERPROFILE%\.infraon-signing\update-signing-key.pem by default, used by scripts/sign-update.js) and must never be
 * committed.
 *
 * Rotating the key without breaking automatic updates:
 *   1. Add the new public key here, next to the old one, and publish that release signed with the OLD key.
 *      Installed clients accept it (old key) and from then on trust both keys.
 *   2. Sign later releases with the new key (sign-update.js --key <new.pem>).
 *   3. Once every client runs a release from step 1 or later, remove the old key here.
 */
export const UPDATE_PUBLIC_KEYS: readonly string[] = [
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA+w6DQhwPYEh2Liwrv6zx5RTGlcPZeUhoMsqquCg+jME=
-----END PUBLIC KEY-----
`,
];
