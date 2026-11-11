# Third-party components

The project's own source is MIT licensed. Bundled dependencies keep their own licenses.

| Component | Version | Source and license |
| --- | --- | --- |
| Node.js for Windows x64 | 24.22.2 | [Official release](https://nodejs.org/download/release/v24.22.2/), MIT and bundled notices in `licenses/NODE-LICENSE.txt` in the release package |
| Frida Node.js bindings | 17.23.2 | [Frida](https://github.com/frida/frida/tree/17.23.2), LGPL-2.0 with the wxWindows 3.1 exception; see `licenses/FRIDA-COPYING.txt` and `licenses/FRIDA-LGPL-2.0.txt` |
| npm runtime dependencies | Locked in `package-lock.json` | Their original license files remain inside each bundled `node_modules` package |

The bundled Node and Frida binaries are unmodified upstream binaries. Frida source and build instructions are available from the upstream repositories at the matching version. This distribution includes no KakaoTalk executable, reconstructed executable, disassembly dump, chat database, user media, or analysis tools. KakaoTalk is a trademark of its owner; this helper is an independent project.
