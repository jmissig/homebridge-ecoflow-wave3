# Current

## Now

- [ ] Validate login, MQTT subscription, initial state refresh, and reconnect
  behavior against the household WAVE 3.
- [ ] Validate each exposed command on hardware before calling it supported:
  power, cool, heat, auto, target temperature, fan-only, and fan speed.
- [ ] Capture anonymized binary fixtures for display, runtime, and command
  acknowledgement messages.

## Next

- [ ] Verify the Home app presentation and Siri behavior in an isolated
  Homebridge child bridge.
- [ ] Confirm whether EcoFlow permits the app and plugin MQTT connections to
  remain online simultaneously.
- [ ] Add explicit command acknowledgement/time-out handling.
- [ ] Decide how to represent dry mode, condensate-full warning, automatic
  drainage, and Pet Care without cluttering the primary climate accessory.

## Later

- [ ] Investigate local MQTT redirection or Bluetooth after cloud-backed
  control is stable.
- [ ] Prepare publication metadata and a release only after real-hardware
  validation.
