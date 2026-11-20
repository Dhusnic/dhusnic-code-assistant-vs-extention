# Update server (same host as the LLM gateway)

Installed extensions fetch `https://<gateway host>/infraon-assistant/updates/latest.json` 30 seconds after VS Code starts and then every 4 hours. They also check when someone runs **Infraon Assistant: Check for Updates**. When the manifest lists a newer, correctly signed version, the extension downloads the `.vsix`, checks its SHA-256 against the signed manifest, installs it, and asks the user to reload the window. That prompt waits until no agent is running.

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

`-Mandatory` makes the reload prompt modal, so users can't postpone it. You can set `INFRAON_UPDATE_TARGET` once instead of passing `-PublishTarget`. If no target is set, the signed files are staged in `dist\updates\` for you to copy manually: copy the `.vsix` first, then `latest.json`.

## Installer downloads (first installs)

Copy `InfraonCodeAssistant-Installer.zip` and `InfraonCodeAssistant-Mac-Installer.zip` from the repo root to `/srv/infraon-assistant/downloads/`. The Teams message links to:

- https://172.16.48.75:30400/infraon-assistant/downloads/InfraonCodeAssistant-Installer.zip
- https://172.16.48.75:30400/infraon-assistant/downloads/InfraonCodeAssistant-Mac-Installer.zip

## Signing key

- The private key is in `%USERPROFILE%\.infraon-signing\update-signing-key.pem` on the build machine. **Back it up somewhere safe.** If it's lost, every installed copy has to be updated by hand once with the installer.
- The public key is in `src/core/updateKey.ts`. `scripts/sign-update.js` refuses to sign with a key that doesn't match it.
- Never commit `*.pem` (it is in `.gitignore`).

## Admin controls (central policy)

- `"disableAutoUpdate": true` turns updates off.
- `"updateUrl": "https://…/latest.json"` uses another manifest location.

Users can set `infraonAssistant.autoUpdate: false`. They will then be asked before each install.
