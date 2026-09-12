# Windows packaging

Run the assisted NSIS installer build from `frontend`:

```powershell
pnpm.cmd package:win
```

The installer is written to:

`H:\My-soft\vibe-projects\Reverie\将Reverie打包至各个平台\半成品\Windows`

Override the output directory with `REVERIE_WINDOWS_OUT`. Reverie 0.5.5
artifacts are written to `H:\bm2026\0.5.5`.

The installer defaults to per-machine `C:\Program Files\Reverie` and still
lets the user change the directory. A custom page asks whether to create a
desktop shortcut. Electron entrypoints are packaged in integrity-checked ASAR. The
corresponding TypeScript and Python source, build scripts, licenses, and
lockfile are emitted as a zip beside the installer, never inside the
executable production payload.

Runtime data is initialized under Electron's per-user `userData/data`
directory. Installing or updating the application never overwrites existing
memories, diaries, API settings, or other user-created local state.

## Live2D runtime

Live2D is **opt-in at package time**. A build that does not set the flags
below ships without Cubism Core, and onboarding Live2D import fails closed
with `AVATAR_LIVE2D_DISABLED`.

Required for a public Live2D-capable installer:

```powershell
$env:REVERIE_LIVE2D_PUBLIC_BUILD = "1"
$env:REVERIE_LIVE2D_CORE_PATH = "H:\path\to\Live2DCubismCore.js"
$env:REVERIE_BUILD_PYTHON = "H:\path\to\python.exe"   # must import PIL
pnpm.cmd package:win
```

- `REVERIE_LIVE2D_CORE_PATH` must point at a regular `Live2DCubismCore.js`.
  Missing this variable is a hard error when Live2D is enabled (it must not
  silently produce an installer that cannot import models).
- `LICENSES_CREDITS/LIVE2D_PUBLICATION_LICENSE.json` is copied into
  `resources/` and checked by the runtime gate.
- Public installers are **Cubism Core only**. They never stage `character/`
  or a yumi model, even if `REVERIE_YUMI_SOURCE` / `皮套-yumi` exists. New
  users import their own `*.model3.json` folder during onboarding. Character
  cards change persona text only; they do not swap Live2D.
- User-imported textures larger than 4096px are downscaled in the isolated
  staging directory by `resources/downscale-live2d-textures.py` (Pillow). A
  transform failure never rejects the import; it records
  `texture_downscale_unavailable` and continues.

Do not set `REVERIE_ONBOARDING_TEST_INSTALLER=1` for a publishable build.
That flag produces an internal-test installer with `TEST-BUILD-DO-NOT-RELEASE`.
