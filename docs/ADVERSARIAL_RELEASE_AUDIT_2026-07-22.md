# Reverie Windows adversarial release audit — 2026-07-22

## Verdict

The merged implementation plan is complete at the code and automated-QA level. The product is not yet authorized for a public release: the hardware/accessibility/human acceptance gates below require real people or equipment and must not be inferred from emulation.

## First-principles invariants

1. **Identity is authority, not prompt text.** Stable persona facts are sealed into an integrity fingerprint, privileged activation advances an epoch, persona-coupled stores are namespaced, and stale runtimes cannot commit.
2. **An optional capability may fail; the persona kernel may not.** Feature imports are lazy and isolated. If an interactive feature is missing, the authenticated desktop bridge starts in an explicit degraded state and keeps identity/policy operations available.
3. **A paid side effect is never guessed.** Chat requests have durable identities. A crash after provider dispatch is uncertain and is never automatically sent again. A partial local commit is reported as uncertain, never completed.
4. **Network/API access is a denied capability until the owner grants it.** Local mode is enforced below feature code; optional AI purposes use provider-and-origin-bound, revocable, deny-by-default grants.
5. **The local device is the source of truth.** Core identity, memory, chat delivery, Focus timing, avatars, settings, and backup work without a cloud service.
6. **Capacity is a resource property, not a product quota.** Durable memory collections have no artificial record-count eviction. Practical limits are disk space, SQLite/filesystem limits, vector-index cost, and query-time bounds.

## Murphy-law cases covered

- Persona card or registry tampering; stale persona epoch; cross-persona memory/backup restore.
- Missing modules and startup exceptions; missing cloud service.
- Provider hang, cancellation, paid-call crash, reveal-once, and local side-effect failure.
- Backup source swap, symlink, oversized/corrupt credential file, header/URL credential injection, interrupted restore.
- ZIP Slip, archive bombs/collisions, broken GLB/VRM/VRMA, external model URIs, preview failure, active-avatar deletion, and unlicensed Live2D payloads.
- Focus crash recovery, sleep/resume, wall-clock rollback, stale timer generation, repeated toggles, rejected audio autoplay, and corrupt state.
- Strict CSP, untrusted IPC sender, navigation/window restrictions, bridge authentication, single-controller ownership, and local-mode network blocking.
- 7 viewport families at 100/125/150/200% zoom, keyboard focus, reduced motion, high-contrast CSS, IME-safe Enter, and WebGL context-loss handling.

## Automated evidence

- Python: **2649 passed, 21 skipped**.
- Renderer: **164 passed**; TypeScript checks passed.
- Electron: **56 passed**.
- Production build passed; portable Windows test package passed its release-boundary verifier.
- Visual smoke: **0 renderer errors, 0 failures, 0 undersized targets, 0 horizontal-overflow cases**.

## External release gates still required

- Intel UHD 620, 1080p, 125%: collect p95 frame time, CPU/GPU and memory deltas with the exact release build.
- RDP, Narrator, physical keyboard/IME and forced-colors hands-on passes.
- Five-person blind test with the plan's 4/5 findability and style thresholds.
- Live2D stays excluded from public packages until the applicable Expandable Application review/publication agreement is recorded. VRM/GLB/VRMA remain releasable.

## Research basis

- Electron security checklist: https://www.electronjs.org/docs/latest/tutorial/security
- Pixiv VRM animation API: https://pixiv.github.io/three-vrm/docs/modules/three-vrm-animation.html
- Live2D publication licensing: https://www.live2d.com/en/sdk/license/
- Live2D Expandable Applications: https://www.live2d.com/en/sdk/license/expandable/
- SQLite implementation limits: https://sqlite.org/limits.html
- WCAG 2.2: https://www.w3.org/TR/WCAG22/
- Windows touch-target guidance: https://learn.microsoft.com/en-us/windows/apps/develop/input/guidelines-for-targeting
