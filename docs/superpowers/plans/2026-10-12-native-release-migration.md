# Native release migration execution

Approved design: ../specs/2026-10-12-native-release-migration-design.md.
Execute in-session: packaging, core pin and updater contracts depend on each other.

1. Port legacy setup checks and verify maintenance/edition restrictions plus dashboard tests.
2. Add shared native packaging and extracted-archive smoke to Community; extend existing Azure Pipeline.
3. Update Pro core pin, add public-key build input and native package integration; extend existing Azure Pipeline.
4. Prepare isolated-channel promotion and fail-closed updater changes in the infrastructure owner. Test locally with fake service/network fixtures; never operate the live farm.
5. Run appropriate local suites, builds and package smoke checks. Open own-repository PRs and monitor all required validations before handoff.
6. Before actual promotion/cutover: review real verification-key/customer inputs, authorize protected migration rehearsal and the coordinated production window. Keep publication and live infrastructure changes pending explicit approval.
