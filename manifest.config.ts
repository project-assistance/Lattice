import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json'

export default defineManifest({
  manifest_version: 3,
  name: 'Lattice',
  version: pkg.version,
  icons: {
    16: 'public/logo.png',
    32: 'public/logo.png',
    48: 'public/logo.png',
    128: 'public/logo.png',
  },
  background: {
    service_worker: 'src/background/background.ts',
    type: 'module',
  },
  action: {
    default_icon: {
      16: 'public/logo.png',
      32: 'public/logo.png',
      48: 'public/logo.png',
    },
    default_popup: 'src/popup/index.html',
  },
  
  permissions: [
    'offscreen',
    'tabs',
    'storage',
    'alarms',
    'sidePanel',
    'languageModel',
    'tabGroups',
  ],

  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  options_page: 'src/settings/index.html',
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
})
