<p align="center">
  <a href="https://molekule.com"><img src="https://github.com/csirikak/homebridge-molekule/assets/32028457/9736d1ff-ddcc-4f9d-87c9-dc6607a1ec29" height="140"></a>
</p>
<span align="center">
  
# homebridge-molekule
<a href="https://github.com/QandnotU/homebridge-molekule/releases/latest"><img title="latest release" src="https://img.shields.io/github/v/release/QandnotU/homebridge-molekule?include_prereleases&sort=semver&label=release"></a>
<a href="https://github.com/QandnotU/homebridge-molekule/releases"><img title="downloads" src="https://img.shields.io/github/downloads/QandnotU/homebridge-molekule/total?label=downloads"></a>
<img title="homebridge" src="https://img.shields.io/badge/Homebridge-v1%20%26%20v2-blue">
</span>

<span align="left">

A Homebridge Plugin for Molekule Air Purifiers. Compatible with both Homebridge v1 and Homebridge v2. Once you install this plugin you can say:

```
Hey Siri, what's the status of the Air Purifier Filter?
Hey Siri, set the speed of the Molekule to 60%.
Hey Siri, what's the air quality in the Living Room?
```

## Installation

Search for Molekule under Plugins in the Homebridge UI.
Or, copy and paste the following into a terminal

```bash
npm -g i homebridge-molekule
```

## Configuration

It should be configurable in plugin settings using homebridge-ui-x, if not, add this to your config.json file under Platforms.

```json
{
  "platform": "Molekule",
  "name": "homebridge-molekule",
  "email": "YOUR EMAIL HERE",
  "password": "YOUR PASSWORD HERE",
  "threshold": 10,
  "excludeAirMiniPlus": false,
  "silentAuto": false,
  "quietMode": false,
  "co2Threshold": 1000,
  "pollInterval": 30
}
```

- `threshold` sets the percentage at which a filter change warning is dislayed in the home app
- `excludeAirMiniPlus` disables Air Mini+ so you can use their native HomeKit function
- `silentAuto` **default only** — when a device is switched to Auto *from its purifier tile*, start in Quiet (true) vs Standard (false). Air Pro only
- `quietMode` adds a **Quiet Mode** switch on the purifier (Air Pro only) — a *live* toggle for Quiet mode (enables Auto + Quiet). Independent of `silentAuto`; the two stay in sync. Ungroup in the Home app if you want it as its own tile
- `co2Threshold` CO₂ level in ppm above which the CO₂ sensor reports a detected/abnormal state
- `pollInterval` how often (seconds, default 30) device state is refreshed from the Molekule API — HomeKit changes apply instantly; this governs how fast changes made elsewhere (physical controls, the app, air-quality drift) show up

# v1.5.0
- fan-speed slider now snaps to the device's real speeds (via RotationSpeed minStep) instead of any percent
- optional **Quiet Mode** switch on the purifier for Air Pro (`quietMode`) — grouped with the device, Ungroup in Home for its own tile; its tile is labelled "Quiet Mode" (via ConfiguredName)
- HomeKit Model now shows the marketing name (e.g. "Molekule Air Pro") instead of the internal codename ("Sequoia Basic")
- AirQuality now reflects the worse of the PM2.5-derived level and Molekule's own air-quality label (PM2.5 alone read "Excellent" while VOC/CO₂ were elevated)
- Homebridge v2 support (now requires Node.js 22 or 24)
- air quality, PM2.5/PM10/VOC, **CO₂ (new dedicated sensor)** and humidity are now exposed on their correct HomeKit sensor services — fixes the "characteristic not in required or optional" warnings
- filter status moved to a proper linked FilterMaintenance service
- offline devices now reported via StatusActive/StatusFault on the sensors
- AirQuality is derived from PM2.5 for finer (5-level) reporting
- optional **Quiet** switch for Air Pro (`quietMode`)
- single shared poll loop (`pollInterval`) instead of an API call per HomeKit read
- firmware version now displays correctly (Molekule's 4-part version trimmed to HomeKit's 3-part format)
- replaced the unused `node-fetch` dependency with Node's built-in `fetch`
- updated `amazon-cognito-identity-js` to v6 and modernised the toolchain (ESLint flat config, TypeScript 5)
- fixed the filter-change `threshold` default never being applied
- fixed auto/smart mode being silently disabled on newly-added auto-capable devices
- stopped logging account credentials in debug output
- **note:** the `AQIseparate` option was removed — sensors are now always on their own services

# v1.4.1
- renamed `normal` to `standard`
- added `AQIseparate` switch to separate humidity and AQI reporting
- minor bug fixes

# Notes and Issues

Using an incorrect password can cause a need for a full password reset on your account. Pay special attention to the password you're using.
This plugin loads the names that are set for each device in the Molekule app.
</span>
