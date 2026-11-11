# v0.1.1

Windows x64 startup reliability update for PC KakaoTalk 26.9.2.5342 (32-bit).

- Waits for an explicit `runtime-ready` event with the expected process ID before calling agent RPC.
- Retries only an early strict byte-guard startup failure, with at most six total attempts and a five-second delay between attempts.
- Unloads the script and detaches the session after a pre-readiness failure without calling RPC that does not exist yet. Once ready, native ownership cleanup drains before unloading.
- Keeps executable hashes and native byte guards unchanged; guard errors now record expected and actual bytes.
- Retains inline playback, focus pause/resume, the tray toggle and the bundled private Node.js 24.22.2 / Frida 17.23.2 runtimes.

Known limits: fast scrolling may produce a small positioning delay; unavailable originals cannot play; other KakaoTalk builds are unsupported.

Known Avast issue: during development, Avast quarantined an installed `KakaoTalkInlineGif.exe` as **IDP.Generic** at **2026-11-11 20:25:38 KST**. The quarantined launcher's SHA-256 was `4b503c8cf7a6d2c37970dee64df238af0fa4d70d6eaacd53a9f2f5d77aa3f699`. The release binary is a fresh build with a different hash; the same integration may still be blocked. The detection's validity and related behavior are under review. Neither malware nor a false positive has been confirmed. The startup changes in v0.1.1 do not establish that Avast compatibility is resolved.

Validation: 55 isolated synthetic checks passed (9 renderer, 10 transport, 7 launcher, 17 resolver, 12 host-readiness checks). Runtime verification loaded the bundled Frida binding and discovered its local device without attaching to an application. Startup-registration regression coverage uses a separate synthetic registry key, not the real login startup key.

The ZIP contains only program files, empty initial configuration and dependency licenses. User GIFs, cache indexes, runtime logs, registry backups and analysis dumps are excluded.
