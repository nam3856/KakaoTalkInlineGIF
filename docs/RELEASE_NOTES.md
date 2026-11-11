# v0.1.0

Initial Windows x64 release for PC KakaoTalk 26.9.2.5342 (32-bit).

- Plays animated GIF originals at their chat-bubble positions without opening the image viewer.
- Pauses on focus loss and resumes from the retained frame.
- Includes a tray toggle, orderly shutdown, per-user installation and optional login startup.
- Bundles private Node.js 24.22.2 and Frida 17.23.2 runtimes.
- Checks the supported KakaoTalk executable hash and native entry bytes before using its integration.

Known limits: fast scrolling may produce a small positioning delay; unavailable originals cannot play; other KakaoTalk builds are unsupported.

Validation: 43 isolated synthetic checks passed (9 renderer, 10 transport, 7 launcher, 17 resolver). Runtime verification loaded the bundled Frida binding and discovered its local device without attaching to an application. Startup-registration regression coverage uses a separate synthetic registry key, not the real login startup key.

The ZIP contains only program files, empty initial configuration and dependency licenses. User GIFs, cache indexes, runtime logs, registry backups and analysis dumps are excluded.
