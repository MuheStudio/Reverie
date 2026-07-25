# Windows packaging

Run the assisted NSIS installer build from `frontend`:

```powershell
pnpm.cmd package:win
```

The installer is written to:

`H:\My-soft\vibe-projects\Reverie\将Reverie打包至各个平台\半成品\Windows`

The installer supports per-user/per-machine mode and a user-selected install
directory. Electron entrypoints are packaged in integrity-checked ASAR. The
installed `resources/SOURCE_CODE` directory
contains the corresponding TypeScript and Python source, build scripts,
licenses, lockfile, and source maps required for a GPL-3.0 source build.

Runtime data is initialized under Electron's per-user `userData/data`
directory. Installing or updating the application never overwrites existing
memories, diaries, API settings, or other user-created local state.
