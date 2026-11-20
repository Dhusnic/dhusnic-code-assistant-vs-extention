/**
 * Public half of the update-signing key. The private half lives only on the build machine
 * (%USERPROFILE%\.infraon-signing\update-signing-key.pem, used by scripts/sign-update.js) and must never be committed.
 * Rotating the key: ship one release signed with the old key that carries the new public key here.
 */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA+w6DQhwPYEh2Liwrv6zx5RTGlcPZeUhoMsqquCg+jME=
-----END PUBLIC KEY-----
`;
