# ECANDI — third-party notices and license terms

ECANDI is a fork of **Electron Capture** by Steve Seguin
(https://github.com/steveseguin/electroncapture), distributed under the
**GNU General Public License v3.0**. The full license text ships alongside this
file as `LICENSE.md`; all Electron Capture-derived code remains under GPL-3.0
with upstream attribution preserved.

ECANDI bundles the components below. Nothing here restricts your rights under
the GPL to the ECANDI/Electron Capture source itself.

---

## NDI®

ECANDI sends and receives video using **NDI®**.

Copyright © 2023–2026 **Vizrt NDI AB**. All rights reserved.

**NDI® is a registered trademark of Vizrt NDI AB.** ECANDI is not a product of
Vizrt NDI AB, and no sponsorship or endorsement by Vizrt NDI AB is implied. The
NDI mark appears here and in ECANDI's interface and documentation solely to
identify that ECANDI is compatible with NDI products.

ECANDI redistributes exactly one NDI SDK component — the NDI runtime library
`Processing.NDI.Lib.x64.dll` — as object code used by this application, in
accordance with the NDI® Technology License Agreement (November 2024). No other
part of the NDI SDK (headers, import libraries, tools, or documentation) is
redistributed. The SDK itself is fetched at build time and is never committed to
this project's source repository.

### Terms that apply to your use of ECANDI's bundled NDI components

Required by the NDI® Technology License Agreement §3(d), and binding on every
recipient of this application:

1. You may not modify the NDI SDK, the NDI runtime library, or any NDI product,
   or any part thereof.
2. You may not reverse engineer, disassemble, or recompile the NDI SDK, the NDI
   runtime library, any NDI product, or any protocol used by them — whether that
   protocol is transmitted over a network or used internally to the machine,
   physical or virtual, on which it runs — nor attempt to do so.
3. You may not circumvent any technical limitation in the NDI SDK, the NDI
   runtime library, or any NDI product.
4. You may not remove, obscure, or alter any proprietary notice or label
   contained on or within the NDI SDK, the NDI runtime library, or any NDI
   product.
5. **Vizrt NDI AB and its licensors disclaim all warranties** with respect to
   the NDI components, which are provided "as is".
6. To the fullest extent permitted by applicable law, **Vizrt NDI AB and its
   licensors are not liable for any damages** — direct, indirect, incidental, or
   consequential — arising from use of this application or its bundled
   components.
7. You must comply fully with all relevant United States export laws and
   regulations, and must not export this application or any part of it, directly
   or indirectly, in violation of United States law.
8. Any third-party developer who uses this application to build further products
   must themselves comply with the NDI® SDK license — including maintaining
   current and complete NDI compatibility — and must carry these same terms into
   their own end-user license agreement.

The full agreement is published by NDI at http://ndi.link/ndisdk_license.

---

## @stagetimerio/grandiose

Node.js N-API bindings to the NDI SDK, used for NDI send (fallback sender mode)
and NDI receive (console previews).

Licensed under the **Apache License, Version 2.0**
(http://www.apache.org/licenses/LICENSE-2.0).

Copyright © Streampunk Media Ltd. and contributors — Lukas Hermann
(Stagetimer), Dr. Ralf S. Engelschall, Ian Shade, Dan Jenkins.
Source: https://github.com/stagetimerio/grandiose

## ndi-texture-send

ECANDI's default NDI sender — a native module written for this project that
reads Electron's offscreen shared textures and sends NDI off the main thread. It
is original work in this repository and is covered by the repository's GPL-3.0
license. It links the same NDI runtime library described above.

## Electron and Chromium

ECANDI runs on a custom build of **Electron** (43.3.0-qp20, maintained at
https://github.com/steveseguin/electron), which embeds **Chromium** and
**Node.js**. Electron is MIT-licensed; Chromium and its dependencies carry their
own licenses. Both license collections ship with this application as
`LICENSE.electron.txt` and `LICENSES.chromium.html`.

## VB-Audio, Dante, OBS, vdo.ninja

ECANDI interoperates with these systems but bundles no part of them. They are
installed and licensed separately by their own vendors and projects, and their
trademarks belong to their respective owners.
