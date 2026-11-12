# Updates

Installed copies check this repo's [releases](https://github.com/sanchezrobertodev/mimikit/releases) quietly on
launch, and whenever you press **Check for updates** in the sidebar footer or the search palette. A new version shows
its CHANGELOG notes, and **Install & restart** downloads it, verifies its signature and relaunches. Versions up to 0.3.6
checked the old [asset-den-releases](https://github.com/sanchezrobertodev/asset-den-releases) repo instead; its last
feed points them to 0.3.7 here, which checks this repo from then on.

Windows x64, macOS (both architectures) and the Linux AppImage update themselves. A `.deb` install, or a platform the
feed has no build for, hides **Check for updates**, so it never hits a missing-platform error. The first version with
the updater has to be installed by hand: 0.2.0 on Windows, 0.3.7 on macOS and Linux.
