# Device routing

DeviceYard Pro can route jobs using administrator-assigned device tags. Configure
tags on the device configuration page, then submit, for example:

```sh
deviceyard cloud app.apk flows/ --device-tags tablet,camera
```

These are device tags, separate from flow `--include-tags`. They are administrator
assertions, not automatically detected hardware capabilities. Every requested tag
must be present on the selected device. No match leaves the job queued; unrelated
compatible jobs can proceed. Jobs without requirements retain normal scheduling.

To run jobs in a clean Android work profile instead, see [isolation](isolation.md).

The multipart `POST /run` equivalent is `requiredDeviceTags=["tablet","camera"]`.
At most 16 unique tags are accepted. Each is 1–32 lowercase ASCII letters, digits
or hyphens and begins with a letter or digit. Invalid requirements are rejected.

Job details show requirements and the current waiting reason. Queued requirements
survive restart. If Pro entitlement becomes unavailable, constrained jobs remain
queued; Community fallback runs only unconstrained jobs. Editing device tags
affects future assignments, not tests already running.

Schema version 14 adds these fields. Do not downgrade a database containing
constrained queued jobs to a pre-routing binary, which cannot enforce them.
Use the matching backup when rolling back an installation.
