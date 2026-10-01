# Third-party components

The vendored scrcpy server is version 3.3.2. Its upstream Apache-2.0 license is preserved at `vendor/scrcpy/LICENSE` and copied into build output. Upstream: https://github.com/Genymobile/scrcpy.

JavaScript dependencies are pinned by the root and dashboard lockfiles. Their original license files remain in installed packages. A complete distribution notice inventory and compatibility review must be completed before public release.

`tests/fixtures/ContactManager.apk` and `tests/fixtures/selendroid-test-app.apk` are retained in this private candidate for regression testing only. Their source, exact upstream versions, redistribution licenses, and corresponding notices must be verified or they must be replaced before publication.
