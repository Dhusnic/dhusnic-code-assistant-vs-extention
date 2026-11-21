# Update server (same host as the LLM gateway)

Installed extensions fetch `https://<gateway host>/infraon-assistant/updates/latest.json` 30 seconds after VS Code starts and then every 4 hours. They also check when someone runs **Infraon Assistant: Check for Updates**. When the manifest lists a newer, correctly signed version, the extension downloads the `.vsix`, checks its SHA-256 against the signed manifest, installs it, and asks the user to reload the window. That prompt waits until no agent is running. The extension sends no credentials to this server: every manifest field (version, package, hash, minimum VS Code, mandatory flag, notes) is signed, so the files can be served over the gateway's self-signed certificate. Only the user's own settings (or the central policy) decide which server is used; workspace settings are ignored.

**Merge order:** finish the server setup below and publish the first release before announcing automatic updates. Until then clients get a 404, which they treat as "nothing published yet" and stay quiet about.

## One-time server setup

**nginx in front of the gateway.** Create `/srv/infraon-assistant/updates/`. Then add [`nginx-location.conf`](nginx-location.conf) to the gateway's `server { }` block, above the location that proxies to the LLM, and reload nginx.

**Kubernetes ingress instead.** Run any static file server (for example `nginx:alpine`) with a volume mounted at `/usr/share/nginx/html/infraon-assistant/updates`. Then route the path on the gateway's ingress to it:

```yaml
- path: /infraon-assistant/updates
  pathType: Prefix
  backend: { service: { name: infraon-assistant-updates, port: { number: 80 } } }
```

Checking the route: `curl -k https://172.16.48.75:30400/infraon-assistant/updates/latest.json` should return the manifest (a 404 is expected before the first release).

## Publishing a release

```powershell
.\deploy.ps1 -Version 0.26.0 -Publish -PublishTarget user@172.16.48.75:/srv/infraon-assistant/updates -Notes "What changed"
```

`-Mandatory` makes the reload prompt modal. Users can still dismiss it, but it comes back every 10 minutes until they reload, and it is installed even when `autoUpdate` is off. You can set `INFRAON_UPDATE_TARGET` once instead of passing `-PublishTarget`. If no target is set, the signed files are staged in `dist\updates\` for you to copy manually: copy the `.vsix` first, then `latest.json`.

## Installer downloads (first installs)

Copy `InfraonCodeAssistant-Installer.zip` and `InfraonCodeAssistant-Mac-Installer.zip` from the repo root to `/srv/infraon-assistant/downloads/`. The Teams message links to:

- https://172.16.48.75:30400/infraon-assistant/downloads/InfraonCodeAssistant-Installer.zip
- https://172.16.48.75:30400/infraon-assistant/downloads/InfraonCodeAssistant-Mac-Installer.zip

## Signing key

- The private key is in `%USERPROFILE%\.infraon-signing\update-signing-key.pem` on the build machine. **Back it up somewhere safe.** If it's lost, every installed copy has to be updated by hand once with the installer.
- The trusted public keys are listed in `src/core/updateKey.ts`. `scripts/sign-update.js` refuses to sign with a key that matches none of them.
- Never commit `*.pem` (it is in `.gitignore`).
- **Rotating the key** without breaking automatic updates:
  1. Generate the new key pair. Add the new public key to `UPDATE_PUBLIC_KEYS` next to the old one, then publish that release signed with the **old** key (the default). Clients install it and from then on trust both keys.
  2. Sign later releases with the new key: `node scripts/sign-update.js --vsix … --out … --key <new.pem>`.
  3. Once every client runs a release from step 1 or later, remove the old key.

## Admin controls (central policy)

- `"disableAutoUpdate": true` turns updates off.
- `"updateUrl": "https://…/latest.json"` uses another manifest location.

Users can set `infraonAssistant.autoUpdate: false` in their user settings. New releases are then announced and installed only when they click Install (mandatory releases are still installed).
