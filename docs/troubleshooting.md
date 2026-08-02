# Troubleshooting and recovery

This guide applies to the unpublished Matter-only `0.2` development line.
Start with the [commissioning runbook](commissioning.md) for a first install.

## Update before diagnosing

Development installs should use the checked-in packed-artifact helper:

```sh
git pull --ff-only
./npm-install-dev-build.sh
```

Restart only the EcoFlow child bridge afterward. Ordinary code updates do not
require removing the Matter bridge from Apple Home or pairing it again.

Do not use `npm install -g .` from the checkout. That creates a development
symlink and can load a second Matter.js runtime whose class identities do not
match global Homebridge.

## The accessory is missing from Homebridge's accessory screen

That screen lists HAP accessories. This plugin publishes Matter only, so use
Apple Home or another controller commissioned to the EcoFlow child bridge.
Confirm the child bridge has Matter enabled and HAP disabled.

## No Response during startup

Startup presentation depends on the age of the last authoritative device
state:

- State confirmed within the last 15 minutes remains visible while the new
  cloud session reconnects, but commands stay blocked until current-session
  state arrives.
- Missing or older cached state sets Matter reachability false, which Apple
  Home presents as No Response.
- For missing/old state, the plugin sends one WAVE-specific action-71 full
  display request. It separately retries the read-only `latestQuotas` request
  with bounded backoff until authoritative power/mode state arrives.

Persistent No Response is not fixed by repeatedly tapping controls. Check, in
order:

1. The WAVE is online in the EcoFlow app.
2. The configured serial number exactly matches the intended WAVE 3.
3. The configured API region matches the account.
4. Logs reach `EcoFlow MQTT session is ready`.
5. Debug logs show a full display packet with sleep/power and operating-mode
   evidence, followed by controller availability becoming `online`.

Partial temperature or humidity packets prove the device is publishing but do
not make control safe by themselves.

After authoritative startup state arrives, the plugin allows five minutes
without another recognized state update before setting reachability false.
This covers one missed WAVE full-display upload plus normal timing jitter;
command confirmation still uses its separate ten-second deadline.

## Authentication or regional API failure

Use the API host associated with the EcoFlow account:

- `api.ecoflow.com` — Global
- `api-a.ecoflow.com` — Americas
- `api-e.ecoflow.com` — Europe

The plugin intentionally rejects other hosts unless its advanced override is
explicit. Verify credentials in Homebridge configuration rather than pasting
them into logs or issue reports. EcoFlow's service is private and app-facing;
an app/API change can break this integration without warning.

## A command moved the WAVE but Homebridge reported failure

Enable debug logging on only the EcoFlow child bridge and follow one command
sequence. Current builds emit redacted semantic lifecycle lines:

```text
controller command started sequence=… command=…
controller command publication accepted sequence=…
controller command acknowledgement progress sequence=…
controller command observed-state confirmation sequence=…
controller command completed sequence=… outcome=…
```

EcoFlow may split a composite command into several acknowledgement packets or
omit some echoed fields. The plugin accumulates per-field evidence from fresh
pre-command state, matching acknowledgement fragments, and later display
deltas; no one packet must restate the complete command. An explicit rejection,
conflicting value, confirmation timeout, or disconnect still fails closed.

Matter.js commits valid writable thermostat/fan attributes before the cloud
round trip finishes. If EcoFlow later rejects a write, the plugin logs a
failure; if the evidence deadline expires without rejection, it instead logs
`confirmation timed out`. Both restore the latest confirmed device state, so
Apple Home may briefly show the requested value before that reconciliation.

## The WAVE selected its remembered 26°C target

The WAVE stores separate parameters for its operating modes. A mode-only Heat
command can restore Heat's remembered target—26°C on the household unit—even
when Apple Home had just displayed a different target. Current builds include
the presented Cool/Heat target, or both Auto thresholds, with every mode
transition. If this still occurs, capture the semantic command and subsequent
acknowledgement/state lines rather than changing several controls at once.

## Fan Only, Dry, or Sleep is absent

The plugin implements the standard Matter `Thermostat.systemMode` values for
Fan Only, Dry, and Sleep. As of the iOS 27 beta, neither Apple Home nor Eve
presents those values for this Room Air Conditioner, so they cannot currently
be selected through those apps. Sleep means the WAVE Night/Sleep submode, not
a timer.

Do not assume these modes are simple independent switches. WAVE display state
contains separate saved airflow, temperature, and humidity parameters per
mode. Controller-visible alternatives remain experimental until those profile
semantics can be validated safely.

## Temperature or humidity looks wrong

Check the per-device `currentTemperatureSource`:

- `ambient` publishes ambient temperature and humidity.
- `outlet` publishes the indoor supply-air/outlet temperature and no humidity.
- `none` publishes neither local temperature nor humidity.

Changing this setting changes the Matter endpoint's cluster shape. Restart the
child bridge after editing configuration; the plugin re-registers the same
stable device identity, so routine source changes should not require pairing
again.

The WAVE accepts fractional Celsius targets over its protocol even though its
physical Celsius display shows whole numbers. Matter has no standard attribute
for advertising a whole-degree-only picker increment, so Apple Home controls
the visible adjustment granularity.

## Room assignment or accessory metadata is wrong

Apple Home owns rooms, names, scenes, and automations. The plugin cannot move
an accessory between rooms. Try the same metadata change from another Home
client before resetting anything; transient Home/iCloud synchronization issues
do not justify deleting Homebridge or Matter caches.

Firmware is published through standard Matter bridged-device information, but
Apple Home currently does not display it for this accessory.

## When re-pairing is actually needed

Do not re-pair for plugin updates, ordinary child-bridge restarts, EcoFlow
authentication failures, temporary No Response, or a temperature-source
configuration change.

Re-pair only when the Matter bridge was deliberately removed from Apple Home,
its commissioning/fabric state was reset, or its Homebridge bridge identity
changed. Use this order:

1. Remove the EcoFlow Matter bridge from Apple Home.
2. Open the EcoFlow child bridge's Matter pairing/settings screen in the
   Homebridge UI and reset or recommission only that bridge using the controls
   provided by the installed Homebridge version.
3. Restart only that child bridge.
4. Scan the newly generated QR code and recreate room/scene/automation
   assignments as needed.

Do not delete broad Homebridge caches as a first troubleshooting step.

## Collecting a safe diagnostic excerpt

Enable child-bridge debug logging, reproduce exactly one action, and include:

- startup through `EcoFlow MQTT session is ready` when diagnosing availability;
- the semantic command lifecycle shown above;
- the first resulting display-state update and final controller snapshot;
- what Apple Home, the EcoFlow app, and the physical WAVE each did.

Never include passwords, tokens, MQTT credentials, full account/device topics,
full serial numbers, Matter QR codes, setup codes, or raw packet bytes. The
plugin redacts its own diagnostics, but review surrounding Homebridge output
before sharing it.

## Known platform risks

- Homebridge's Matter implementation is uncertified; Apple Home may warn when
  commissioning it.
- EcoFlow provides no supported WAVE 3 cloud API for this integration.
- Internet, EcoFlow authentication, its MQTT service, Homebridge, and the
  commissioned Matter fabric are all required for control.
- A working EcoFlow mobile app does not prove the private API behavior used by
  this plugin is unchanged.
