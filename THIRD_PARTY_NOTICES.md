# Third-party notices

## EcoFlow Cloud Integration for Home Assistant

WAVE 3 protocol research and the planned protobuf implementation are informed
by:

- Project: `tolwi/hassio-ecoflow-cloud`
- Source: https://github.com/tolwi/hassio-ecoflow-cloud
- Pinned source commit:
  https://github.com/tolwi/hassio-ecoflow-cloud/commit/95dc51eb12562c49be9067052814d5960cc0829f
- WAVE 3 contribution: https://github.com/tolwi/hassio-ecoflow-cloud/pull/762
- License: Apache License 2.0
- License text: [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)

The upstream project and its contributors retain their copyrights. Any source
or schema copied from, or substantially adapted from, that project must remain
identified as Apache-2.0 material, preserve applicable notices, and state that
it has been modified.

The first port is scoped and traced in [docs/protocol.md](docs/protocol.md).
The reviewed subset in `proto/ecoflow/wave3/v1/wave3.proto` and its generated
TypeScript remain licensed under Apache License 2.0. Both carry provenance and
modification notices.

## homebridge-ecoflow

Architecture and HomeKit modeling were compared with:

- Project: `PietroLubini/homebridge-ecoflow`
- Source: https://github.com/PietroLubini/homebridge-ecoflow
- License: MIT

No source from that project is currently included. If code is later copied or
adapted, add its required MIT copyright and permission notice here or beside
the affected files.
