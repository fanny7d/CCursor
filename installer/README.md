# @cometix/ccursor

Cursor++ BYOK Installer — Bring Your Own Key for Cursor IDE.

This is the fanny7d development fork. Build this checkout and use
`node dist/cli.cjs <command>` to include its compatibility fixes. The npm commands
below refer to the upstream package. See [DEVELOPMENT.md](../DEVELOPMENT.md).

## Install

```bash
npx @cometix/ccursor install
```

## Uninstall

```bash
npx @cometix/ccursor uninstall
```

## Status

```bash
npx @cometix/ccursor status
```

## Notes

- **After every Cursor update, re-run `install`** — updates overwrite the patched bundles.
- **Cursor 3.23+ (especially Remote-SSH):** if agents fail with
  `AI Model Not Found / Model name is not valid: "<id>"`, re-run `install` and restart Cursor.
  The installer forces Cursor's `cursor_agent_host` topology back to the `legacy`
  implementation, which restores Cursor++'s interception of agent requests.
- This fork's actual UI acceptance covers macOS Apple Silicon and Cursor 3.25.9;
  Remote SSH and other OS/version combinations still need independent acceptance.
