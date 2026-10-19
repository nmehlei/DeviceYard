# APK test fixtures

These unmodified APKs exercise APK metadata extraction and upload handling.
They are test inputs, not dependencies of the DeviceYard server, and are not
included in its native or container runtime packages.

Both binaries match Appium's official `sample-apps` repository at commit
[`0e92532585431d3b362c1ff12c65b54936fbe26f`](https://github.com/appium/sample-apps/tree/0e92532585431d3b362c1ff12c65b54936fbe26f/pre-built).
Its [package metadata](https://github.com/appium/sample-apps/blob/0e92532585431d3b362c1ff12c65b54936fbe26f/package.json)
declares Apache-2.0. The binaries have not been rebuilt or modified here.

| File | Git blob | SHA-256 |
| --- | --- | --- |
| ContactManager.apk | `418f504bde28ee5fae806e2e060f488e7abe791f` | `7370e929d3ea2ef8dd030b2b0e2a86ea4e0019a6de3d1dd6aec40b0752e01722` |
| selendroid-test-app.apk | `55cf569fb7fe1cd707a71d3fc5fef2e55cef8c3d` | `6d3c24239a7313f1c98c1897914547f6faca36aa3a2b1b8ae262ab5fa9007282` |

## Attribution evidence

- ContactManager: Copyright (C) 2009 The Android Open Source Project.
  The [original sample source](https://github.com/aosp-mirror/platform_development/blob/android-4.4.4_r2/samples/ContactManager/src/com/example/android/contactmanager/ContactManager.java)
  carries an Apache-2.0 header. This identifies the sample lineage, not a claim
  that we reproduced the binary from that particular Android source tag.
- Selendroid test app: Copyright 2012-2014 eBay Software Foundation and
  selendroid committers. The [original app source](https://github.com/selendroid/selendroid/blob/0.12.0/selendroid-test-app/src/main/java/io/selendroid/testapp/HomeScreenActivity.java)
  carries an Apache-2.0 header. Our binary reports `0.12.0-SNAPSHOT`; the exact
  binary provenance is the pinned Appium blob above, not a reproduced build
  from the final Selendroid 0.12.0 tag.
- Selendroid includes Apache Commons IO classes. Its upstream
  [test-app dependency declaration](https://github.com/selendroid/selendroid/blob/0.12.0/selendroid-test-app/pom.xml)
  specifies Commons IO 2.2. Preserve its applicable notice with these fixtures.
- Appium Sample Code (https://github.com/appium/sample-code),
  Copyright 2013-2014 Appium Contributors. ContactManager also matches the
  sample-code repository at commit `47fc0305396b8322b727820ca55a07607395040c`;
  that repository's Selendroid binary is different and is not our provenance.

See `LICENSE-APACHE-2.0.txt` for the licence text and `NOTICE.txt` for preserved
attribution. These components retain their upstream licences; DeviceYard's
first-party AGPL licence does not replace them.
