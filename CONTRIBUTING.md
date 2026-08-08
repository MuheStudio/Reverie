# Contributing to Reverie

Welcome! Pull requests, forks, and modifications are all welcome.

## License

Reverie is licensed under **GPL-3.0** (the client application as a whole). Any derivative works you publish must also remain open source under the same license.

- Client application source code: **GPL-3.0** (see `LICENSE`).
- Official cloud services (data backup, AI compute hosting, network acceleration) are separate commercial proprietary services and are **not** covered by this license. See `README.md` and `AGPL_EXCLUDED.md`.

When using third-party code, you must preserve the original copyright notices and licenses, and comply with the obligations of each license (Apache-2.0 modification notices, NOTICE merging, etc.). See `LICENSES_CREDITS/` and `CREDITS.md`.

## Mandatory Quality Requirement

All code contributions MUST be reviewed **from first principles** with an **adversarial mindset**, and MUST be reasoned about from the perspective of **Murphy's law** (anything that can go wrong, will go wrong):

- **First principles**: question every assumption. Do not trust code that merely "works once"; verify the underlying invariants and design constraints.
- **Adversarial review**: attack your own code as an attacker would — prompt injection, identity takeover, memory corruption, data loss, privilege escalation, privacy leakage, and any path that breaks personality continuity.
- **Murphy's law**: plan for failure — crashes, interruptions, retries, partial writes, missing modules, and malicious inputs. Every failure path must degrade gracefully without breaking personality continuity or destroying user data.

This is a **mandatory** requirement, not a suggestion. Pull requests that fail this review will be returned for revision.

## Ways to Contribute

- **Bug reports**: Open an issue with clear reproduction steps
- **Feature suggestions**: Open an issue describing the use case
- **Code contributions**: Fork, implement, and submit a PR
- **Platform ports**: macOS, iOS, HarmonyOS ports are especially welcome (author currently focuses on Windows → Android → Linux)

## Development

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run the full quality gate:
   - Python: `python -m pytest`
   - Frontend: `pnpm typecheck && pnpm test && pnpm build`
   - Packaging smoke: `pnpm package:win:test && pnpm smoke:package`
5. Perform the mandatory first-principles adversarial review described above
6. Submit a pull request
