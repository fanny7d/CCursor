# Cursor 3.25.9 / NAS acceptance

Verified on 2026-10-21 using macOS Apple Silicon, Cursor 3.25.9 and this fork's Cursor++ 0.0.15 source.
This public summary omits private endpoints, credentials, machine paths, conversation IDs and screenshots.

## Accepted path

Cursor → local Cursor++ BYOK server → NAS api2cursor gateway → Sub2API → gpt-6-luna.

- OpenAI Chat input, translated by the separate NAS gateway into Responses upstream requests.
- Model default max; picker choices low / medium / high / xhigh / max.
- Gateway thinking_level=default; explicit client efforts retained on the final upstream wire request.
- HTTP/1.1 transport enabled in the tested Cursor instance.
- Real credentials remain outside Git in the operator's private configuration.

## Verification

- Cursor++ server: 371 tests passed; TypeScript passed.
- Installer: 10 tests passed; 1 optional real-application fixture skipped.
- Separate NAS gateway: 7 tests passed, including 12 effort/protocol subcases.
- Actual UI Max chat returned UI_EFFORT_MAX_OK.
- Actual Max file read/write/read preserved an unpredictable nonce and produced the correct sum.
- Five effort probes returned expected replies and reported matching upstream efforts.
- Native filename/content searches, formula rendering and chat restoration after restart passed.
- Original punycode, HTTP/2 config, extra-file verification and empty-context-blob warnings were repaired.

Gateway tests and effort-preservation changes are in the separate api2cursor project, not this repository.

## Subsequent extension cleanup

The independent Codex extension inside Cursor was uninstalled at the operator's request.
Cursor++ does not require it. A fresh restart showed no Codex extension activation.
The NAS Max read/write/read regression returned NAS_MAX_UNINSTALL_OK, with four successful gateway requests.
Protected provider, routes, settings and installed Cursor++ bundle hashes remained unchanged.

## Limits

Remote SSH, Agent Host-specific features and other Cursor/OS versions were not accepted by these tests.
Remaining native Cursor startup messages and historical-project metadata probes are outside this claim.
Detailed evidence is retained privately. Cursor updates may overwrite app patches;
run compatibility checks and actual model/tool acceptance before using a new Cursor build.
