// bootstrap() fires work-profile cleanup against real adb at startup. Tests
// boot the app constantly with no phone attached; skip it so no async adb work
// outlives a test. tests/workProfiles.test.ts covers the cleanup directly.
process.env.DEVICEYARD_SKIP_PROFILE_CLEANUP = "1";
