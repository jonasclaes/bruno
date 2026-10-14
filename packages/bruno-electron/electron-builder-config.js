require('dotenv').config({ path: process.env.DOTENV_PATH });

const isBenchmark = process.env.BRUNO_BENCHMARK === 'true';

const sopsResources = (platform) => [{
  from: `../bruno-common/sops/bin/${platform}-\${arch}`,
  to: `sops/${platform}-\${arch}`,
  filter: ['sops', 'sops.exe']
}];

const config = {
  appId: 'com.usebruno.app',
  productName: isBenchmark ? 'Bruno Benchmark' : 'Bruno',
  extraMetadata: {
    brunoBuild: {
      benchmark: isBenchmark,
      builtAt: new Date().toISOString()
    }
  },
  electronVersion: '37.6.1',
  directories: {
    buildResources: 'resources',
    output: 'out'
  },
  extraResources: [
    {
      from: '../bruno-common/sops/NOTICE',
      to: 'sops/NOTICE'
    },
    {
      from: 'resources/data/sample-collection.json',
      to: 'data/sample-collection.json'
    }
  ],
  files: ['**/*'],
  beforePack: async (context) => {
    const { Arch } = require('builder-util');
    await require('../../scripts/bundle-sops').bundleSops([
      `${context.electronPlatformName}-${Arch[context.arch]}`
    ]);
  },
  afterSign: 'notarize.js',
  mac: {
    extraResources: sopsResources('darwin'),
    artifactName: '${name}_${version}_${arch}_${os}.${ext}',
    category: 'public.app-category.developer-tools',
    target: [
      {
        target: 'pkg',
        arch: ['x64', 'arm64']
      },
      {
        target: 'dmg',
        arch: ['x64', 'arm64']
      },
      {
        target: 'zip',
        arch: ['x64', 'arm64']
      }
    ],
    icon: 'resources/icons/mac/icon.icns',
    hardenedRuntime: true,
    identity: 'Anoop MD (W7LPPWA48L)',
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    notarize: false,
    requirements: 'resources/app-requirements.txt',
    protocols: [
      {
        name: 'Bruno',
        schemes: [
          'bruno'
        ]
      }
    ]
  },
  linux: {
    extraResources: sopsResources('linux'),
    artifactName: '${name}_${version}_${arch}_${os}.${ext}',
    icon: 'resources/icons/png',
    target: [
      {
        target: 'AppImage',
        arch: ['x64', 'arm64']
      },
      {
        target: 'deb',
        arch: ['x64', 'arm64']
      },
      {
        target: 'rpm',
        arch: ['x64', 'arm64']
      }
    ],
    protocols: [
      {
        name: 'Bruno',
        schemes: ['bruno']
      }
    ],
    category: 'Development',
    desktop: {
      MimeType: 'x-scheme-handler/bruno;'
    }
  },
  deb: {
    // Docs: https://www.electron.build/configuration/linux#debian-package-options
    depends: [
      'libgtk-3-0',
      'libnotify4',
      'libnss3',
      'libxss1',
      'libxtst6',
      'xdg-utils',
      'libatspi2.0-0',
      'libuuid1',
      'libsecret-1-0',
      'libasound2' // #1036
    ]
  },
  win: {
    extraResources: sopsResources('win32'),
    artifactName: '${name}_${version}_${arch}_win.${ext}',
    icon: 'resources/icons/win/icon.ico',
    target: [
      {
        target: 'nsis',
        arch: ['x64', 'arm64']
      }
    ],
    sign: null,
    publisherName: 'Bruno Software Inc'
  },
  nsis: {
    include: 'resources/installer.nsh',
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    allowElevation: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true
  },
  pkg: {
    installLocation: '/Applications',
    isRelocatable: false
  }
};

module.exports = config;
