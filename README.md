# 433 Listener

A single-file web page that turns an RTL-SDR USB dongle into a 433 MHz radio listener. Open it in Chrome or Edge, plug in the dongle, and it shows what is being transmitted around you: weather sensors, doorbells, remotes, car keys, alarms and other little ISM-band gadgets.

Everything runs locally in your browser through WebUSB. Nothing is uploaded, no account is needed, and the page makes no network requests. Your device names, hidden devices and settings are kept only in your browser's local storage.

## What it does

- **Listens and detects** short 433 MHz bursts with a sensitive multi-channel detector (or a simpler classic mode), with a live waterfall.
- **Decodes known protocols** by matching what it hears against a database of device fingerprints taken from rtl_433.
- **Tracks unknown devices.** Repeated transmissions that look alike are grouped into one device card, even when nobody has described the protocol yet.
- **Lets you name and hide devices**, and export a packet's raw IQ recording (`.cu8`) for use in other tools.
- **Analyze screen** for reverse engineering: compare several devices side by side (waveforms, hex, bits, timings, common sections, checksum search) and write rules that say "these sections mean it's the same device", even if the packet lengths differ.
- **AI prompt export** turns a packet or device into a text summary you can paste into any AI assistant.

## Using it

1. Install the WinUSB driver for the dongle with Zadig (Windows only, once). Close any other SDR program.
2. Open `433-listener.html` in Chrome or Edge, from a file or localhost.
3. Press Connect and pick the dongle.

## Building from source

```
npm install
node build.js
```

This bundles the sources in `src/` into one self-contained `433-listener.html`. The device database is created by `tools/extract_rtl433.py <rtl_433 checkout> build/devices.json`.

## Licence

This project is licensed under the **GNU General Public License, version 2 or (at your option) any later version** (GPL-2.0-or-later). See `LICENSE`.

It is GPL because it contains data derived from rtl_433, which uses that licence. The same terms cover the combined single-file page, and if you redistribute it you must keep the source available under the same licence.

Copyright (C) 2026 ZS6SVE
### Third-party material

- **rtl_433** (https://github.com/merbanan/rtl_433), GPL-2.0-or-later. The device fingerprint database (`build/devices.json`) is generated from its source files (names, pulse timings, modulation, bit lengths). Credit and thanks to the rtl_433 authors and contributors. The commit used is recorded in the database's metadata.
- **webrtlsdr** by Jacobo Tarrio (https://github.com/jtarrio/webrtlsdr), Apache-2.0. It provides the WebUSB driver for the RTL2832U/R820T2 and is bundled into the page. Its licence text is in `licenses/webrtlsdr-APACHE-2.0.txt`. Apache-2.0 code may be combined into GPL-2.0-or-later projects (GPLv3 terms apply to that part).
- **esbuild** (MIT) is used only at build time and is not shipped.

Device and brand names that appear in the database (Acurite, Oregon Scientific and so on) are used only to identify products. This project is not affiliated with or endorsed by any of those companies, nor by the rtl_433 project.

## Please be considerate

Only listen to what the law in your country lets you receive, and don't use this to track or target people. Raw IQ captures can contain other people's transmissions, so don't publish them without thinking about that first.
