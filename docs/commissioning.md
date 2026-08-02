# Matter child-bridge commissioning

Use this runbook for the first real installation of the 0.2 Matter-only line.
It prepares only the EcoFlow child bridge; other Homebridge bridges may remain
paired through HAP.

The protocol and identity migration is intentional: the previous HAP child
bridge and the new Matter child bridge are different Apple Home accessories.
Room assignments, names, scenes, and automations do not migrate automatically.
See [Decision 0003](decisions/0003-matter-only.md).

## Before changing the running bridge

1. Record the old EcoFlow accessory's room, scenes, and automations.
2. Confirm the WAVE 3 is online and controllable in the EcoFlow app.
3. Confirm the Homebridge runtime account reports Node.js 24 or newer and
   Homebridge 2.2.1 or newer:

   ```sh
   node --version
   homebridge --version
   ```

4. Keep the EcoFlow account password and full serial number out of chat and
   logs. Enter them only in the local Homebridge configuration.

## Install the reviewed checkout

Run these commands as the same Saga account that runs Homebridge:

```sh
cd /path/to/homebridge-ecoflow-wave3
git pull --ff-only
npm install
npm run verify
npm run build
npm install -g .
```

Confirm Homebridge reports plugin version `0.2.0` before commissioning.

## Replace the old pairing

1. Remove the old EcoFlow HAP child bridge from Apple Home. This does not
   remove its Apple Home automations.
2. In the EcoFlow child bridge settings, disable HAP and enable Matter. Leave
   every other bridge unchanged:

   ```json
   "_bridge": {
     "username": "AA:BB:CC:DD:EE:FF",
     "port": 30141,
     "debugModeEnabled": true,
     "hap": { "enabled": false },
     "matter": {
       "enabled": true,
       "name": "EcoFlow WAVE 3"
     }
   }
   ```

   The username and port above are placeholders; retain the values generated
   for the actual child bridge.
3. Restart only the EcoFlow child bridge.
4. Confirm the logs show Matter accessory registration, EcoFlow
   authentication, and an MQTT-ready session without a HAP registration.
5. Open the EcoFlow child bridge's Matter pairing screen in Homebridge and add
   its QR code to Apple Home. Accept the uncertified-accessory warning if Apple
   presents one.

## First read-only check

Before issuing any Apple Home control:

1. Confirm exactly one WAVE 3 accessory appears.
2. Assign it to the intended room.
3. Confirm power/mode state, selected current-temperature source, optional
   humidity, fan state, and firmware are plausible.
4. Open the EcoFlow app at the same time and confirm both clients continue to
   receive state.
5. Save the redacted EcoFlow debug section from child-bridge startup through
   the first complete state snapshot.

Do not test a batch of controls at once. Continue with Phase M7 in
[`TODO.md`](../TODO.md): one command, acknowledgement, observed state, and
physical result at a time.

## Stop conditions

Stop the first run and preserve redacted logs if:

- the plugin registers any HAP climate accessory;
- more than one WAVE 3 accessory appears for one configured serial;
- Matter state changes without a corresponding confirmed WAVE state;
- the EcoFlow app or plugin loses control when the other client is active;
- identifiers, credentials, full topics, or raw packet bytes appear in logs;
- the child bridge repeatedly reconnects or fails to shut down cleanly.

## If pairing does not appear

- Reconfirm Homebridge 2.2.1 or newer and plugin 0.2.0.
- Reconfirm Matter is enabled and HAP disabled on this child bridge.
- Reconfirm the platform configuration passes validation and includes an
  explicit WAVE 3 serial.
- Enable debug mode only on the EcoFlow child bridge and inspect registration
  before resetting or deleting any Matter pairing data.
- Do not enable HAP as a fallback; 0.2 intentionally has no HAP presentation.
