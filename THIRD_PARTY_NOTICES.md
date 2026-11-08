# Third-party notices

Durango Code's own source is covered by [LICENSE](LICENSE). This file lists
third-party work that Durango Code adapts ideas from or installs at run time.

## agent-device

Simulator tools install [agent-device](https://github.com/callstack/agent-device)
on demand (pinned in `src/main/devices/device-tool-versions.json`) into the
app's user data directory when the user lets agents use devices. It is not
bundled with Durango Code.

```
MIT License

Copyright (c) 2026 Callstack

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## libheif (libheif-js)

Durango Code ships [libheif-js](https://github.com/catdad-experiments/libheif-js),
a WebAssembly build of [libheif](https://github.com/strukturag/libheif), to
convert HEIC/HEIF image attachments to JPEG on Windows and Linux. libheif is
licensed under the GNU Lesser General Public License v3.0 (LGPL-3.0); libheif-js
is LGPL-3.0 as well. It ships unmodified as a separate module
(`node_modules/libheif-js` inside the app), which can be replaced with another
build of the same version; its license texts are included there.

## T3 Code

The design of Durango Code's simulator tools (four `device_*` tools, driving
through an agent-device launcher bound to one device, refusing commands that
would replace its connection, and naming a sandbox when localhost is blocked)
follows T3 Code's device support (`apps/server/src/device/`,
`docs/internals/devices.md`). No T3 Code source is copied; where a Durango Code
file follows that design, it says so in a comment.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
