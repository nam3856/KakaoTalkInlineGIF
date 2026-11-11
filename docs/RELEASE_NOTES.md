# v0.1.0

Initial Windows x64 release for PC KakaoTalk 26.9.2.5342 (32-bit).

- Plays animated GIF originals at their chat-bubble positions without opening the image viewer.
- Pauses on focus loss and resumes from the retained frame.
- Includes a tray toggle, orderly shutdown, per-user installation and optional login startup.
- Bundles private Node.js 24.22.2 and Frida 17.23.2 runtimes.
- Checks the supported KakaoTalk executable hash and native entry bytes before using its integration.

Known limits: fast scrolling may produce a small positioning delay; unavailable originals cannot play; other KakaoTalk builds are unsupported.

Known Avast issue: during development, Avast quarantined an installed `KakaoTalkInlineGif.exe` as **IDP.Generic** at **2026-11-11 20:25:38 KST**. The quarantined launcher's SHA-256 was `4b503c8cf7a6d2c37970dee64df238af0fa4d70d6eaacd53a9f2f5d77aa3f699`. The v0.1.0 release binary is a fresh build with a different hash; the same integration may still be blocked. The detection's validity and related behavior are under review. Neither malware nor a false positive has been confirmed.

Validation: 43 isolated synthetic checks passed (9 renderer, 10 transport, 7 launcher, 17 resolver). Runtime verification loaded the bundled Frida binding and discovered its local device without attaching to an application. Startup-registration regression coverage uses a separate synthetic registry key, not the real login startup key.

The ZIP contains only program files, empty initial configuration and dependency licenses. User GIFs, cache indexes, runtime logs, registry backups and analysis dumps are excluded.
