const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

const macSigningIdentity = process.env.ORION_MAC_SIGN_IDENTITY
  || 'Developer ID Application: R&R Unicorns, LLC (KV46DBU287)';
const macEntitlements = path.join(__dirname, 'build', 'entitlements.mac.plist');
const macNonCodeResourcePattern = /\.(?:pak|bin|dat|png|jpe?g|gif|icns|ico|ttf|woff2?)$/i;
// @electron/packager wipes `<tmpdir>/electron-packager` at the start of every
// run, so concurrent packaging from another checkout (rifts, worktrees) would
// delete this build's staged app mid-signing. Stage per checkout instead. It
// must live outside the project: packager copies the project into staging.
const packagerTmpdir = path.join(
  os.tmpdir(),
  'orion-packager',
  crypto.createHash('sha256').update(__dirname).digest('hex').slice(0, 16),
);
// Linux needs a lowercase, space-free executable for /usr/bin and the
// .desktop entry. macOS and Windows keep the "Durango Code" executable.
const linuxExecutableName = 'durango-code';
const isLinuxBuild = process.platform === 'linux';

module.exports = {
  packagerConfig: {
    // node-pty's spawn-helper and rift-snapshot's prebuilt CLI are plain
    // executables (no .node extension), so the auto-unpack-natives plugin
    // alone won't unpack them — unpack the whole modules. The plugin merges
    // its own '**/*.node' pattern into this.
    asar: { unpack: '**/node_modules/{node-pty,rift-snapshot,@anthropic-ai/claude-agent-sdk-*}/**' },
    icon: path.join(__dirname, 'assets', 'icon'),
    tmpdir: packagerTmpdir,
    ...(isLinuxBuild ? { executableName: linuxExecutableName } : {}),
    extraResource: [
      path.join(__dirname, 'assets', 'icon.png'),
      path.join(__dirname, 'assets', 'bundled-skills'),
      // Tells electron-updater to update Linux installs through the .deb.
      ...(isLinuxBuild ? [path.join(__dirname, 'build', 'linux', 'package-type')] : []),
    ],
    // Customer-facing bundle name. The bundle id, the internal app name
    // ("Orion", pinned in src/main/pin-app-identity.js), the userData path and
    // the "Orion Safe Storage" keychain item must NOT change — installed users
    // depend on them. See docs/durango-rebrand.md.
    name: 'Durango Code',
    appBundleId: 'com.complexia.orion',
    appCategoryType: 'public.app-category.developer-tools',
    extendInfo: {
      CFBundleDisplayName: 'Durango Code',
      NSAppleEventsUsageDescription:
        'Durango Code uses Apple Events so agents can control Mac apps on your behalf.',
    },
    osxSign: {
      identity: macSigningIdentity,
      hardenedRuntime: true,
      entitlements: macEntitlements,
      ignore: (filePath) => macNonCodeResourcePattern.test(filePath),
    },
  },
  // node-pty's Windows prebuilds are Node-API (any Electron ABI) and ship the
  // ConPTY/winpty binaries; compiling it instead needs MSVC Spectre libraries.
  // Linux has no prebuild and is compiled.
  rebuildConfig: process.platform === 'win32' ? { ignoreModules: ['node-pty'] } : {},
  hooks: {
    // The Vite plugin packages only the `.vite` bundle (everything else is
    // ignored), so runtime externals must be copied into the app manually.
    // node-pty stays external (native module) — copy it and restore the
    // exec bit on its spawn-helper, which npm strips from prebuilds. Its gyp
    // file resolves node-addon-api while Forge rebuilds the copied module, so
    // that transitive dependency must be present in the otherwise-minimal
    // Vite package too.
    packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform, arch) => {
      const fs = require('node:fs');
      // Vite bundles the SDK JavaScript, but its Claude Code executable must
      // ship separately and outside ASAR for the fallback runtime to launch.
      const claudePackage = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
      const claudeSource = path.join(__dirname, 'node_modules', claudePackage);
      const claudeTarget = path.join(buildPath, 'node_modules', claudePackage);
      fs.cpSync(claudeSource, claudeTarget, { recursive: true, dereference: true });
      if (platform !== 'win32') fs.chmodSync(path.join(claudeTarget, 'claude'), 0o755);
      const nodeAddonApiSrc = path.join(__dirname, 'node_modules', 'node-addon-api');
      const nodeAddonApiDest = path.join(buildPath, 'node_modules', 'node-addon-api');
      fs.cpSync(nodeAddonApiSrc, nodeAddonApiDest, { recursive: true, dereference: true });
      const src = path.join(__dirname, 'node_modules', 'node-pty');
      const dest = path.join(buildPath, 'node_modules', 'node-pty');
      fs.cpSync(src, dest, { recursive: true, dereference: true });
      const prebuilds = path.join(dest, 'prebuilds');
      if (fs.existsSync(prebuilds)) {
        for (const dir of fs.readdirSync(prebuilds)) {
          const helper = path.join(prebuilds, dir, 'spawn-helper');
          if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
        }
      }

      // rift-snapshot ships the prebuilt `rift` CLI the same way; the main
      // process spawns it for epic rift workspaces.
      const riftSrc = path.join(__dirname, 'node_modules', 'rift-snapshot');
      const riftDest = path.join(buildPath, 'node_modules', 'rift-snapshot');
      if (fs.existsSync(riftSrc)) {
        fs.cpSync(riftSrc, riftDest, { recursive: true, dereference: true });
        const riftPrebuilds = path.join(riftDest, 'prebuilds');
        if (fs.existsSync(riftPrebuilds)) {
          for (const dir of fs.readdirSync(riftPrebuilds)) {
            for (const name of ['rift', 'rift.exe']) {
              const binary = path.join(riftPrebuilds, dir, name);
              if (fs.existsSync(binary)) fs.chmodSync(binary, 0o755);
            }
          }
        }
      }
    },
  },
  makers: [
    {
      // An NSIS installer, because electron-updater (the app's updater on
      // every platform) only installs NSIS updates on Windows.
      name: '@felixrieseberg/electron-forge-maker-nsis',
      platforms: ['win32'],
      config: {
        getAppBuilderConfig: async () => ({
          appId: 'com.complexia.orion',
          productName: 'Durango Code',
          artifactName: 'Durango-Code-Setup-${version}-${arch}.${ext}',
          win: { icon: path.join(__dirname, 'assets', 'icon.ico') },
          nsis: {
            // Per-user install under %LOCALAPPDATA%: no UAC prompt, and
            // updates install silently.
            oneClick: true,
            perMachine: false,
            shortcutName: 'Durango Code',
            uninstallDisplayName: 'Durango Code',
          },
        }),
      },
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        background: path.join(__dirname, 'assets', 'dmg-background.png'),
        contents: (opts) => [
          {
            x: 337,
            y: 166,
            type: 'link',
            path: '/Applications',
          },
          {
            x: 142,
            y: 166,
            type: 'file',
            path: opts.appPath,
          },
        ],
        icon: path.join(__dirname, 'assets', 'icon.icns'),
        iconSize: 80,
        title: 'Durango Code Installer',
        format: 'ULFO',
        additionalDMGOptions: {
          window: {
            size: {
              width: 480,
              height: 313,
            },
          },
        },
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          name: linuxExecutableName,
          bin: linuxExecutableName,
          productName: 'Durango Code',
          genericName: 'Agentic IDE',
          homepage: 'https://code.durango.sh',
          icon: path.join(__dirname, 'assets', 'icon.png'),
          categories: ['Development'],
          // Desktop sign-in returns through orion://auth/callback.
          mimeType: ['x-scheme-handler/orion'],
        },
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
        // If you are familiar with Vite configuration, it will look really familiar.
        build: [
          {
            // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
            entry: 'src/main.js',
            config: 'vite.main.config.mjs',
            target: 'main',
          },
          {
            entry: 'src/preload.js',
            config: 'vite.preload.config.mjs',
            target: 'preload',
          },
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.mjs',
          },
        ],
      },
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      // Durango Code's per-run MCP bridge launches the packaged executable with
      // ELECTRON_RUN_AS_NODE=1 to run its bundled, dependency-free stdio shim.
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
